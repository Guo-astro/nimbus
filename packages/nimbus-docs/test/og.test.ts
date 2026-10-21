// The share-card mechanism behind `@cloudflare/nimbus-docs/og`: fitting text
// by measuring it, emoji and missing-glyph handling, font sources, option
// checks, and loading its optional peers.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { loadCardPeer } from "../src/_internal/card-peer.ts";
import { createCardRenderer, type CardTypography, type FitOptions } from "../src/og.ts";

const FONTS_DIR = path.resolve(import.meta.dirname, "../../nimbus-starter-source/src/pages/og/_fonts");
const MEDIUM = pathToFileURL(path.join(FONTS_DIR, "Inter-Medium.ttf"));
const TITLE: CardTypography = { fontFamily: "Inter", fontWeight: 500, letterSpacing: "-0.025em", lineHeight: 1.1 };
const fit = (overrides: Partial<FitOptions> = {}): FitOptions => ({ width: 920, sizes: [64, 56, 50, 44], lines: 3, style: TITLE, ...overrides });

const renderer = await createCardRenderer({ width: 1200, height: 630, fonts: [{ name: "Inter", source: MEDIUM, weight: 500 }], emoji: "strip" });

/** Captures console.warn while `run` runs. */
async function warnings(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void seen.push(args.join(" "));
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return seen;
}

test("a title that fits keeps the largest size, and the node carries the fit", async () => {
  const result = await renderer.fit("Build a rain alert", fit());
  assert.equal(result.size, 64);
  assert.equal(result.text, "Build a rain alert");
  assert.deepEqual(result.node.props.style, {
    ...TITLE,
    display: "block",
    width: 920,
    fontSize: 64,
    whiteSpace: "normal",
    wordBreak: "break-word",
    lineClamp: 3,
  });
});

test("wide letters step the size down instead of cutting", async () => {
  const title = Array(6).fill("WWWWWWWW").join(" ");
  const result = await renderer.fit(title, fit());
  assert.equal(result.text, title);
  assert.ok(result.size < 64);
});

test("a long word steps down to stay whole, unless whole words are off", async () => {
  const word = "Supercalifragilisticexpialidociousness";
  const whole = await renderer.fit(word, fit({ width: 1000 }));
  const broken = await renderer.fit(word, fit({ width: 1000, preferWholeWords: false }));
  assert.equal(broken.size, 64, "breaking the word fits three lines at the largest size");
  assert.ok(whole.size < broken.size, "keeping it whole takes a smaller size");
  assert.equal(whole.text, word);
});

test("past the smallest size, words come off the end and it ends on an ellipsis", async () => {
  const title = "Load pages from a private Git repository without holding credentials anywhere in the build, the cache or the deployed site";
  const result = await renderer.fit(title, fit({ width: 500, sizes: [44], lines: 2 }));
  assert.equal(result.size, 44);
  assert.match(result.text, /\w…$/u, "cut after a word, not after a space or comma");
  assert.ok(title.startsWith(result.text.slice(0, -1)));
  assert.ok(result.text.length < title.length);
});

test("cutting keeps symbols, not only words", async () => {
  const result = await renderer.fit("+ + + + + + + +", fit({ width: 160, sizes: [40], lines: 1 }));
  assert.match(result.text, /^\+ \+.*…$/u);
});

test("one segment too long for the lines is returned whole for the clamp to end", async () => {
  const word = "a".repeat(200);
  const result = await renderer.fit(word, fit({ width: 100, sizes: [40], lines: 1 }));
  assert.equal(result.text, word);
  assert.equal(result.node.props.style && (result.node.props.style as { lineClamp: number }).lineClamp, 1);
});

test("a long identifier in quotes or brackets keeps its opening mark and its word", async () => {
  const word = "a".repeat(200);
  for (const [open, close] of [["(", ")"], ["\u201c", "\u201d"], ["`", "`"]] as const) {
    const result = await renderer.fit(`${open}${word}${close} more`, fit({ width: 100, sizes: [40], lines: 1 }));
    assert.equal(result.text, `${open}${word}…`);
  }
});

test("emoji: strip removes them before fitting, keep leaves them and warns once", async () => {
  assert.equal((await renderer.fit("Ship it 🚀 today", fit())).text, "Ship it today");
  const stripped = await renderer.fit("🚀", fit());
  assert.deepEqual([stripped.text, stripped.size], ["", 64]);

  const keeping = await createCardRenderer({ width: 1200, height: 630, fonts: [{ name: "Inter", source: MEDIUM, weight: 500 }] });
  let kept = "";
  const seen = await warnings(async () => {
    kept = (await keeping.fit("Ship it 🚀", fit())).text;
    await keeping.fit("Done ✅", fit());
  });
  assert.equal(kept, "Ship it 🚀");
  assert.equal(seen.length, 1, "one warning per kind of text per renderer");
  assert.match(seen[0]!, /\[og\] Share cards contain text the card fonts don't draw \(emoji\)/u);
});

test("text no font covers warns once per kind, naming the fix", async () => {
  const fresh = await createCardRenderer({ width: 1200, height: 630, fonts: [{ name: "Inter", source: MEDIUM, weight: 500 }] });
  const seen = await warnings(async () => {
    await fresh.fit("中文 docs", fit());
    await fresh.fit("日本語", fit());
    await fresh.png((await fresh.fit("中文", fit())).node);
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((line) => line.includes("Add a font that covers it to createCardRenderer({ fonts })")));
  assert.equal(new Set(seen).size, seen.length, "no repeats");
});

test("another font draws the characters Inter lacks, beside Inter", async () => {
  const cjk = new Uint8Array(await readFile(path.join(import.meta.dirname, "fixtures/og/NotoSansSC-subset.ttf")));
  const mixed = await createCardRenderer({
    width: 1200,
    height: 630,
    fonts: [
      { name: "Inter", source: MEDIUM, weight: 500 },
      { name: "Noto Sans SC", source: cjk, weight: 500 },
    ],
  });
  const without = await createCardRenderer({ width: 1200, height: 630, fonts: [{ name: "Inter", source: MEDIUM, weight: 500 }] });
  let withFont: Uint8Array = new Uint8Array();
  let withoutFont: Uint8Array = new Uint8Array();
  const seen = await warnings(async () => {
    const fitted = await mixed.fit("中文 docs", fit());
    assert.equal(fitted.text, "中文 docs");
    withFont = await mixed.png(fitted.node);
  });
  assert.deepEqual(seen, [], "no missing-glyph warning once a font covers the text");
  await warnings(async () => {
    withoutFont = await without.png((await without.fit("中文 docs", fit())).node);
  });
  assert.notDeepEqual(withFont, withoutFont, "the second font draws the characters");
});

test("a font from bytes renders the same card as one from a file URL", async () => {
  const bytes = new Uint8Array(await readFile(MEDIUM));
  const fromBytes = await createCardRenderer({ width: 1200, height: 630, fonts: [{ name: "Inter", source: bytes, weight: 500 }] });
  const node = (await renderer.fit("Same card", fit())).node;
  assert.deepEqual(await fromBytes.png(node), await renderer.png(node));
});

test("options are checked, with errors that name the field", async () => {
  await assert.rejects(renderer.fit("x", fit({ sizes: [44, 64] })), /\[og\] fit\(\) sizes must go from largest to smallest/u);
  await assert.rejects(renderer.fit("x", fit({ sizes: [] })), /\[og\] fit\(\) sizes must be a non-empty list/u);
  await assert.rejects(renderer.fit("x", fit({ lines: 1.5 })), /\[og\] fit\(\) lines must be a positive integer/u);
  await assert.rejects(
    renderer.fit("x", fit({ style: { ...TITLE, padding: 8 } as unknown as CardTypography })),
    /\[og\] fit\(\) style supports only .*; put "padding" on a wrapper/u,
  );
  await assert.rejects(
    createCardRenderer({ width: 1200, height: 630, fonts: [{ name: "Inter", source: new URL("https://example.com/Inter.ttf") }] }),
    /\[og\] fonts\[0\]\.source must be a file: URL or bytes, not https:/u,
  );
  await assert.rejects(createCardRenderer({ width: 0, height: 630, fonts: [{ name: "Inter", source: MEDIUM }] }), /width and height must be positive/u);
});

test("a missing peer names the install; a broken one keeps its error as the cause", async () => {
  await assert.rejects(loadCardPeer("nimbus-card-peer-that-does-not-exist"), /\[og\] Share cards need nimbus-card-peer-that-does-not-exist\. Install satori and @resvg\/resvg-js/u);
  const broken = 'data:text/javascript,throw new Error("no native binding for this platform")';
  await assert.rejects(loadCardPeer(broken), (error: Error) => {
    assert.match(error.message, /is installed but failed to load/u);
    assert.match(String((error.cause as Error).message), /no native binding/u);
    return true;
  });
});

test("no other entry reaches /og, and its peers stay optional", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = await readFile(path.join(root, "tsdown.config.ts"), "utf8");
  const entries = [...config.matchAll(/^\s+"?([\w/-]+)"?:\s*\n?\s*"(src\/[^"]+\.ts)",?$/gmu)].map((m) => [m[1]!, m[2]!] as const);
  assert.ok(entries.some(([name]) => name === "og"), "og is a build entry");
  assert.ok(entries.length > 10, "the entries were read from tsdown.config.ts");

  // Every module reachable from `file` through relative imports, static or dynamic.
  const reach = async (file: string, seen = new Set<string>()): Promise<Set<string>> => {
    if (seen.has(file)) return seen;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const [, spec] of source.matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/gu)) {
      const target = path.resolve(path.dirname(file), spec!).replace(/\.js$/u, ".ts");
      if (target.endsWith(".ts")) await reach(target, seen);
    }
    return seen;
  };
  const og = path.join(root, "src/og.ts");
  for (const [name, entry] of entries) {
    if (name === "og") continue;
    const reached = await reach(path.join(root, entry));
    assert.ok(!reached.has(og), `${name} reaches src/og.ts`);
    for (const file of reached) {
      assert.doesNotMatch(await readFile(file, "utf8"), /["'](?:satori|@resvg\/resvg-js)["']/u, `${name} reaches ${path.relative(root, file)}, which loads a card peer`);
    }
  }

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const peer of ["satori", "@resvg/resvg-js"]) {
    assert.equal(pkg.dependencies?.[peer], undefined, `${peer} isn't a dependency`);
    assert.ok(pkg.peerDependencies[peer], `${peer} is a peer`);
    assert.equal(pkg.peerDependenciesMeta[peer]?.optional, true, `${peer} is optional`);
  }
});
