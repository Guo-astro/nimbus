import assert from "node:assert/strict";
import { test } from "node:test";

import { createSatteriMarkdownProcessor } from "@astrojs/markdown-satteri";
import { mdxToJs } from "satteri";

import { math } from "../src/markdown/math.ts";

test("equations inside components are numbered and referenced in page order", async () => {
  const source = [
    "<Aside>",
    "",
    "$$\n\\begin{equation} a \\label{q}\\end{equation}\n$$",
    "",
    "Inside: $\\eqref{r}$",
    "",
    "</Aside>",
    "",
    "$$\n\\begin{equation} b \\label{r}\\end{equation}\n$$",
    "",
    "See $\\eqref{q}$ and $\\eqref{r}$.",
  ].join("\n");
  const { code } = (await mdxToJs(source, { features: { math: true }, hastPlugins: [math()] } as never)) as {
    code: string;
  };
  assert.deepEqual(code.match(/\((\d|\?\?)\)/g), ["(2)", "(1)", "(2)"]);
});

test("math in a heading keeps a readable TOC label and slug", async () => {
  const processor = await createSatteriMarkdownProcessor({
    features: { math: true },
    hastPlugins: [math()],
  } as never);
  const { metadata } = await processor.render("## Mass–energy $E = mc^2$\n");
  assert.equal(metadata.headings[0]?.text, "Mass–energy E=mc2");
  assert.equal(metadata.headings[0]?.slug, "massenergy-emc2");
});
