/**
 * Typesets math at build time as native MathML, with Temml. Turn on parsing
 * with `features: { math: true }` and rendering with this plugin:
 *
 *   nimbus(config, { markdown: { features: { math: true }, hastPlugins: [math()] } })
 *
 * Pages ship no math JavaScript. Each formula keeps its TeX in an
 * `<annotation>` for assistive technology and tools; the generated Markdown
 * keeps the `$…$` source as written.
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromHtml } from "hast-util-from-html";

import { runtimeWarn } from "../_internal/runtime-warn.js";
import type { HastElement, HastPluginDefinition, HastVisitorContext } from "./types";
import { classNames, isElement } from "./types";

export interface MathOptions {
  /** TeX macros for every formula, such as `{ "\\R": "\\mathbb{R}" }`. */
  macros?: Record<string, string>;
}

/** Marks the plugin so the integration adds the math stylesheet. */
export const MATH_PLUGIN = Symbol.for("nimbus-docs.math");

type Temml = typeof import("temml").default;
type Node = HastElement & { position?: { start?: { line?: number } } };

export function math(options: MathOptions = {}) {
  const factory = (context: { source: string }) => {
    // Math needs a `$` or a math fence; skip every other page cheaply.
    if (!/\$|^[ \t]*(?:`{3,}|~{3,})[ \t]*math/m.test(context.source)) return null;
    let temml: Temml;
    let hasReferences = false;
    // One macro table per page: a `\gdef` serves later formulas on the same page only.
    const macros = { ...options.macros };
    const plugin = {
      name: "nimbus:math",
      options: { position: true },
      async before() {
        temml = (await import("temml")).default;
      },
      element: {
        filter: ["code", "pre"],
        visit(node: Node, ctx: HastVisitorContext) {
          if (node.tagName === "code" && classNames(node).includes("math-inline")) {
            return render(text(node), false, node, ctx, !inHeading(node, ctx));
          }
          if (node.tagName !== "pre") return;
          const code = node.children?.find((child) => isElement(child, "code"));
          if (code && classNames(code).includes("language-math")) {
            return render(text(code), true, node, ctx, true);
          }
        },
      },
      after(root: HastElement, ctx: HastVisitorContext) {
        if (hasReferences) fillReferences(root, ctx);
      },
    };

    // `annotate` embeds the TeX for tools. Not in headings: the heading's text
    // becomes its TOC label and slug.
    function render(tex: string, display: boolean, node: Node, ctx: HastVisitorContext, annotate: boolean): HastElement {
      let html: string;
      try {
        html = temml.renderToString(tex, {
          displayMode: display,
          annotate,
          trust: false,
          macros,
          throwOnError: true,
        });
      } catch (error) {
        // Temml's second line underlines the source; the first says it all.
        const message = (error instanceof Error ? error.message : String(error))
          .split("\n")[0]!
          .replace(/ at position \d+:?$/, "")
          .trim();
        warnOnce(`Math error in ${where(ctx, node)}: ${message}`);
        const source = { type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: tex }] };
        return display
          ? { type: "element", tagName: "pre", properties: { className: ["nb-math-error"], title: message }, children: [source] }
          : { ...source, properties: { className: ["nb-math-error"], title: message } } as HastElement;
      }
      hasReferences ||= html.includes("tml-ref");
      // The annotation is the TeX again: search indexes the formula once.
      const element = withoutPositions(
        fromHtml(
          html.replace('<annotation encoding="application/x-tex">', '<annotation encoding="application/x-tex" data-pagefind-ignore>'),
          { fragment: true },
        ).children[0] as HastElement,
      );
      if (!display) return element;
      return { type: "element", tagName: "div", properties: { className: ["nb-math"] }, children: [element] };
    }

    return plugin as unknown as HastPluginDefinition;
  };
  return Object.assign(factory, { [MATH_PLUGIN]: true });
}

function inHeading(node: Node, ctx: HastVisitorContext): boolean {
  type Any = Parameters<HastVisitorContext["parent"]>[0];
  let parent = ctx.parent(node as unknown as Any) as { tagName?: unknown } | undefined;
  while (parent) {
    if (/^h[1-6]$/.test(String(parent.tagName))) return true;
    parent = ctx.parent(parent as unknown as Any) as typeof parent;
  }
  return false;
}

// Positions from the parsed Temml string point into that string, not the page.
function withoutPositions<N extends { position?: unknown; children?: unknown[] }>(node: N): N {
  delete node.position;
  for (const child of node.children ?? []) withoutPositions(child as N);
  return node;
}

function text(node: { type: string; value?: string; children?: unknown[] }): string {
  if (node.type === "text") return node.value ?? "";
  return ((node.children ?? []) as (typeof node)[]).map(text).join("");
}

// Astro compiles a page more than once; say each problem once.
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  runtimeWarn(message);
}

/** `file:line` in the file as written, frontmatter included. */
function where(ctx: HastVisitorContext, node: Node): string {
  const line = node.position?.start?.line;
  if (!ctx.fileURL) return "a page";
  let absolute = fileURLToPath(ctx.fileURL);
  try {
    absolute = realpathSync(absolute);
  } catch {
    // Not on disk.
  }
  const file = path.relative(process.cwd(), absolute);
  if (!line) return file;
  let before = 0;
  try {
    // Some passes compile the body without its frontmatter.
    const written = readFileSync(absolute, "utf8");
    const start = written.indexOf(ctx.source);
    if (start > 0) before = written.slice(0, start).split("\n").length - 1;
  } catch {
    // Not on disk (a virtual module): the compiled source is all there is.
  }
  return `${file}:${line + before}`;
}

/**
 * Number equations and fill `\ref` / `\eqref`, as Temml's client-side
 * `postProcess` would. Equations count in page order, matching the CSS
 * counter that draws their numbers.
 */
function fillReferences(root: HastElement, ctx: HastVisitorContext): void {
  const labels = new Map<string, string>();
  const refs: HastElement[] = [];
  let count = 0;
  const walk = (node: HastElement, labelled: string[]): void => {
    const classes = classNames(node);
    if (node.tagName === "a" && classes.includes("tml-ref")) refs.push(node);
    const id = typeof node.properties?.id === "string" ? node.properties.id : undefined;
    const owner = id && hasClass(node, "tml-label") ? [...labelled, id] : labelled;
    if (classes.includes("tml-eqn")) {
      count += 1;
      const label = owner.at(-1);
      if (label && !labels.has(label)) labels.set(label, String(count));
    }
    if (classes.includes("tml-tageqn") && id && hasClass(node, "tml-label")) {
      const tag = find(node, "tml-tag");
      if (tag) labels.set(id, text(tag));
    }
    // JSX components (`<Aside>`, tabs) hold equations too.
    for (const child of node.children ?? []) if ("children" in child) walk(child as HastElement, owner);
  };
  walk(root, []);
  for (const ref of refs) {
    const target = String(ref.properties?.href ?? "").slice(1);
    const known = labels.get(target);
    if (known === undefined) warnOnce(`Math reference to an unknown label "${target}" in ${where(ctx, root as Node)}.`);
    let label = (known ?? "??").replace(/^\(|\)$/g, "");
    if (classNames(ref).includes("tml-eqref")) label = `(${label})`;
    ctx.appendChild(ref as never, {
      type: "element",
      tagName: "math",
      properties: {},
      children: [{ type: "element", tagName: "mtext", properties: {}, children: [{ type: "text", value: label }] }],
    } as never);
  }
}

function hasClass(node: HastElement, name: string): boolean {
  return !!find(node, name);
}

function find(node: HastElement, name: string): HastElement | undefined {
  for (const child of node.children ?? []) {
    if (!isElement(child)) continue;
    if (classNames(child).includes(name)) return child;
    const found = find(child, name);
    if (found) return found;
  }
  return undefined;
}
