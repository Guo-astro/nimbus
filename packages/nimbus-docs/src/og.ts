/**
 * `@cloudflare/nimbus-docs/og`: the mechanism behind a site's share cards.
 * It loads fonts, fits text to lines by measuring it, and turns a card into a
 * PNG. What a card looks like stays in the site's own `src/pages/og/_card.ts`.
 *
 * Cards are laid out by Satori and rasterized by resvg, both optional peers:
 * they load on first use, so a site that renders no cards installs neither.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadCardPeer as peer } from "./_internal/card-peer.js";

/** An element Satori lays out: `{ type, props }`, plain object or React element. */
export type CardNode = { type: string; props: Record<string, unknown> };

export interface CardFont {
  /** The family name a style's `fontFamily` refers to. */
  name: string;
  /** A `file:` URL to a TTF, OTF or WOFF file, or the font's bytes. */
  source: URL | Uint8Array;
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  style?: "normal" | "italic";
}

export interface CardRendererOptions {
  width: number;
  height: number;
  /** Every font the card uses. A character the first font lacks is drawn
   *  from the next one that has it, so another script needs only its font. */
  fonts: CardFont[];
  /** `"strip"` removes emoji before fitting; `"keep"` (the default) leaves
   *  them, and they draw only if a font covers them. */
  emoji?: "strip" | "keep";
}

/** The typography `fit` sets text in. Layout belongs on a wrapper. */
export interface CardTypography {
  fontFamily: string;
  lineHeight: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  letterSpacing?: string | number;
  color?: string;
  textAlign?: "left" | "center" | "right";
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
}

export interface FitOptions {
  /** The column's width. */
  width: number;
  /** Font sizes to try, largest first. */
  sizes: number[];
  /** The most lines the text may take. */
  lines: number;
  /** Count a size only if the widest word fits on one line, unless no size
   *  that fits the text allows it. Default `true`. */
  preferWholeWords?: boolean;
  style: CardTypography;
}

export interface FittedText {
  /** The text as set: whole, or cut at a word with "…". */
  text: string;
  size: number;
  /** The text block, sized and clamped; put it in the card as is. */
  node: CardNode;
}

export interface CardRenderer {
  /** The largest size that sets `text` in `lines` lines; past the smallest,
   *  words come off the end until it fits. */
  fit(text: string, options: FitOptions): Promise<FittedText>;
  /** The card as a PNG. */
  png(element: CardNode): Promise<Uint8Array<ArrayBuffer>>;
}

type SatoriFont = { name: string; data: Uint8Array; weight?: CardFont["weight"]; style?: CardFont["style"] };
type SatoriNode = { type: string; textContent?: string; width: number; height: number };
type Satori = (
  element: unknown,
  options: {
    width?: number;
    height?: number;
    fonts: SatoriFont[];
    embedFont?: boolean;
    onNodeDetected?: (node: SatoriNode) => void;
    loadAdditionalAsset?: (code: string, segment: string) => Promise<string | SatoriFont[]>;
  },
) => Promise<string>;
type ResvgModule = {
  Resvg: new (svg: string, options: { font: { loadSystemFonts: boolean } }) => { render(): { asPng(): Uint8Array } };
};

const TYPOGRAPHY = new Set<string>(["fontFamily", "lineHeight", "fontWeight", "fontStyle", "letterSpacing", "color", "textAlign", "textTransform"]);
const EMOJI = new RegExp("\\p{RGI_Emoji}", "gv");
const TRAILING = /[\s\p{P}]+$/u;

function fail(message: string): never {
  throw new Error(`[og] ${message}`);
}

const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

async function fontData(font: CardFont, index: number): Promise<Uint8Array> {
  if (font.source instanceof Uint8Array) return font.source;
  if (font.source instanceof URL) {
    if (font.source.protocol !== "file:") fail(`fonts[${index}].source must be a file: URL or bytes, not ${font.source.protocol}`);
    return new Uint8Array(await readFile(fileURLToPath(font.source)));
  }
  return fail(`fonts[${index}].source must be a file: URL or bytes`);
}

function checkFit(options: FitOptions) {
  if (!positive(options.width)) fail("fit() width must be a positive number");
  if (!Number.isInteger(options.lines) || options.lines < 1) fail("fit() lines must be a positive integer");
  const { sizes } = options;
  if (!Array.isArray(sizes) || sizes.length === 0 || !sizes.every(positive)) fail("fit() sizes must be a non-empty list of positive numbers");
  if (sizes.some((size, i) => i > 0 && size >= sizes[i - 1]!)) fail("fit() sizes must go from largest to smallest");
  for (const key of Object.keys(options.style ?? {})) {
    if (!TYPOGRAPHY.has(key)) fail(`fit() style supports only ${[...TYPOGRAPHY].join(", ")}; put "${key}" on a wrapper`);
  }
  if (typeof options.style?.fontFamily !== "string") fail("fit() style.fontFamily is required");
  if (!positive(options.style?.lineHeight)) fail("fit() style.lineHeight must be a positive number");
}

export async function createCardRenderer(options: CardRendererOptions): Promise<CardRenderer> {
  const { width, height, emoji = "keep" } = options;
  if (!positive(width) || !positive(height)) fail("createCardRenderer() width and height must be positive numbers");
  if (!Array.isArray(options.fonts) || options.fonts.length === 0) fail("createCardRenderer() needs at least one font");
  const [satoriModule, resvg, fonts] = await Promise.all([
    peer<{ default: Satori }>("satori"),
    peer<ResvgModule>("@resvg/resvg-js"),
    Promise.all(
      options.fonts.map(async (font, i): Promise<SatoriFont> => ({
        name: font.name,
        data: await fontData(font, i),
        weight: font.weight,
        style: font.style,
      })),
    ),
  ]);
  const satori = satoriModule.default;

  // Satori asks for a font whenever text needs one none of `fonts` has. Say
  // so once per kind of text for this renderer, rather than draw empty boxes
  // unannounced.
  const warned = new Set<string>();
  const loadAdditionalAsset = async (code: string, segment: string): Promise<SatoriFont[]> => {
    if (!warned.has(code)) {
      warned.add(code);
      console.warn(
        `[og] Share cards contain ${code} text the card fonts don't draw: "${segment}". ` +
          "Add a font that covers it to createCardRenderer({ fonts }).",
      );
    }
    return [];
  };

  const block = (text: string, size: number, fit: FitOptions, clamp: boolean): CardNode => ({
    type: "div",
    props: {
      style: {
        ...fit.style,
        display: "block",
        width: fit.width,
        fontSize: size,
        whiteSpace: "normal",
        wordBreak: "break-word",
        ...(clamp && { lineClamp: fit.lines }),
      },
      children: text,
    },
  });

  /** Lays `element` out without drawing glyphs, and returns the size of the
   *  div whose text is `text`. */
  async function measure(element: CardNode, text: string, measureWidth: number) {
    let box = { width: 0, height: 0 };
    await satori(element, {
      width: measureWidth,
      fonts,
      embedFont: false,
      loadAdditionalAsset,
      onNodeDetected: (node) => {
        if (node.type === "div" && node.textContent === text && node.height >= box.height) box = node;
      },
    });
    return box;
  }

  const container = (child: CardNode, measureWidth: number, fit: FitOptions): CardNode => ({
    type: "div",
    props: { style: { display: "flex", width: measureWidth, fontFamily: fit.style.fontFamily }, children: child },
  });

  async function fits(text: string, size: number, fit: FitOptions) {
    const { height } = await measure(container(block(text, size, fit, false), fit.width, fit), text, fit.width);
    return Math.round(height / (size * fit.style.lineHeight)) <= fit.lines;
  }

  async function widestWordFits(words: string[], size: number, fit: FitOptions) {
    for (const word of words) {
      const node: CardNode = { type: "div", props: { style: { ...fit.style, fontSize: size, whiteSpace: "nowrap", flexShrink: 0 }, children: word } };
      // Measured unconstrained, so the word keeps its natural width.
      const { width: wordWidth } = await measure(container(node, fit.width * 4, fit), word, fit.width * 4);
      if (wordWidth > fit.width) return false;
    }
    return true;
  }

  return {
    async fit(raw, fit) {
      checkFit(fit);
      const text = (emoji === "strip" ? raw.replace(EMOJI, "") : raw).replace(/\s+/gu, " ").trim();
      const largest = fit.sizes[0]!;
      const smallest = fit.sizes[fit.sizes.length - 1]!;
      const done = (set: string, size: number): FittedText => ({ text: set, size, node: block(set, size, fit, true) });
      if (!text) return done("", largest);

      const segments = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)];
      const words = [...new Set(segments.filter((s) => s.isWordLike).map((s) => s.segment))];

      const fitting: number[] = [];
      for (const size of fit.sizes) if (await fits(text, size, fit)) fitting.push(size);
      if (fit.preferWholeWords !== false) {
        for (const size of fitting) if (await widestWordFits(words, size, fit)) return done(text, size);
      }
      if (fitting.length > 0) return done(text, fitting[0]!);

      // Too long at the smallest size: drop segments from the end until it
      // fits, trimming trailing spaces and punctuation from each try.
      let previous = "";
      for (let end = segments.length - 1; end >= 1; end--) {
        const kept = segments.slice(0, end).map((s) => s.segment).join("").replace(TRAILING, "");
        if (!kept || kept === previous) continue;
        previous = kept;
        if (await fits(`${kept}…`, smallest, fit)) return done(`${kept}…`, smallest);
      }
      // One segment too long for the lines: the node's clamp ends it.
      const first = segments[0]!.segment;
      return done(segments.length > 1 ? `${first}…` : first, smallest);
    },

    async png(element) {
      const svg = await satori(element, { width, height, fonts, loadAdditionalAsset });
      // Satori has drawn every glyph as a path, so resvg needs no fonts;
      // loading the system's costs about a second per card.
      return Uint8Array.from(new resvg.Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
    },
  };
}
