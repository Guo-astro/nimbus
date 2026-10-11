import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { mdxToMdast } from "satteri";

import { normalizeAuthoredLinks } from "../src/_internal/authored-links.ts";
import { expandPreparedPartials } from "../src/_internal/build-partials.ts";
import {
  DEFAULT_MARKDOWN_FEATURES,
  setMarkdownFeatures,
} from "../src/_internal/markdown-features.ts";
import { mergePartialHeadings } from "../src/_internal/partial-headings.ts";
import { renderEntryAsMarkdown } from "../src/_internal/transform.ts";
import { parseSource as lintParse } from "../src/lint/parse.ts";

// Valid content that has broken an internal pass before: anything the site's
// own compile accepts must get through every pass.
const CORPUS: Record<string, string> = {
  "astral text before links": "😀😀 [a](/a) 𝒳 and [b](/b)\n\n漢字テキスト [c](/c) 한국어 [d](/d)\n",
  "heading ids": "## Install {#install}\n\nSee [install](/guide#install).\n\n### 日本語 {#ja}\n",
  math: "Inline $\\text{if } x$ and [after](/after).\n\n$$\n\\frac{a}{b} \\text{ when } \\{x\\}\n$$\n",
  "math inside a component": "<Aside>\n\nInline $x^{2}$ {/* note */} here.\n\n</Aside>\n",
  "Markdown inside components":
    '<Tabs>\n  <TabItem label="One">\n\n| a | b |\n| - | - |\n| [x](/x) | 2 |\n\n```js\nconst x = {};\n```\n\n  </TabItem>\n</Tabs>\n',
  comments: "{/* block */}\n\nText {/* inline */} with [a](/a).\n",
  "imports and exports": 'import X from "./x.astro";\nexport const meta = { a: 1 };\n\n# Title\n\n[a](/a)\n',
  "nested components": "<A>\n<B>\n<C>\n\nDeep [link](/deep) 😀\n\n</C>\n</B>\n</A>\n",
};

const FEATURES = { ...DEFAULT_MARKDOWN_FEATURES, headingAttributes: true, math: true };

afterEach(() => setMarkdownFeatures(DEFAULT_MARKDOWN_FEATURES));

/** `output` is `input` with `prefix` inserted, and nothing else changed. */
function onlyInserts(input: string, output: string, prefix: string): boolean {
  let i = 0;
  let o = 0;
  while (o < output.length) {
    if (output.startsWith(prefix, o) && !input.startsWith(prefix, i)) o += prefix.length;
    else if (input[i] === output[o]) {
      i++;
      o++;
    } else return false;
  }
  return i === input.length;
}

for (const [name, source] of Object.entries(CORPUS)) {
  test(`every pass reads what the site compiles: ${name}`, async () => {
    setMarkdownFeatures(FEATURES);
    // The site's own compile accepts it.
    mdxToMdast(source, { features: FEATURES });

    const linked = normalizeAuthoredLinks(source, { base: "/docs", sourceId: "page.mdx" });
    assert.ok(onlyInserts(source, linked, "/docs"), linked);

    await expandPreparedPartials(source, {
      sourceId: "page.mdx",
      getPartial: () => assert.fail("no partials in the corpus"),
    });
    await mergePartialHeadings(source, [], async () => undefined, async () => ({ headings: [] }));

    assert.equal(lintParse(source, { path: "page.mdx", absPath: "/page.mdx", collection: null }).parseError, null);

    const markdown = renderEntryAsMarkdown({ body: source, filePath: "page.mdx" });
    assert.doesNotMatch(markdown, /\{\/\*|^import |^export /m);
  });
}

test("links after astral text get the base in the right place", () => {
  setMarkdownFeatures(FEATURES);
  assert.equal(
    normalizeAuthoredLinks(CORPUS["astral text before links"]!, { base: "/docs", sourceId: "page.mdx" }),
    "😀😀 [a](/docs/a) 𝒳 and [b](/docs/b)\n\n漢字テキスト [c](/docs/c) 한국어 [d](/docs/d)\n",
  );
});

test("heading ids follow the site's features", () => {
  const source = CORPUS["heading ids"]!;
  const parse = () => lintParse(source, { path: "p.mdx", absPath: "/p.mdx", collection: null }).parseError;
  assert.notEqual(parse(), null);
  setMarkdownFeatures({ ...DEFAULT_MARKDOWN_FEATURES, headingAttributes: true });
  assert.equal(parse(), null);
});

test("invalid MDX is reported as the author's syntax error, with the fix", () => {
  assert.throws(
    () => normalizeAuthoredLinks("Set <BACKEND_URL> first.\n", { base: "/docs", sourceId: "setup.mdx" }),
    /^Error: MDX syntax error in setup\.mdx:1:\d+: .*escape it with a backslash or put it in backticks\.$/,
  );
});

test("generated Markdown keeps math and drops comments cleanly", () => {
  setMarkdownFeatures(FEATURES);
  const markdown = (body: string) => renderEntryAsMarkdown({ body, filePath: "page.mdx" });
  assert.equal(markdown(CORPUS.comments!), "Text with [a](/a).");
  assert.match(markdown(CORPUS["math inside a component"]!), /Inline \$x\^\{2\}\$ here\./);
});
