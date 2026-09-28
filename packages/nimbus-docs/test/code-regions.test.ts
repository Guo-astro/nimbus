import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownToMdast } from "satteri-source-parser";

import { fencedBlocks } from "../src/_internal/code-regions.js";

interface MdNode {
  type: string;
  position?: { start: { line: number }; end: { line: number } };
  children?: MdNode[];
}

const FIXTURES = [
  "```js\nconst a = 1;\n```\n",
  "````md\n```\ninner\n```\n````\n\nafter\n",
  "~~~\n```\nstill code\n~~~\n",
  "- step\n\n  ```yaml\n  paths:\n    /a: {}\n  ```\n",
  "> ```sh\n> run\n> ```\n",
  "1. one\n\n   > ~~~~\n   > quoted\n   > ~~~~\n",
  "``` not`a`fence\ntext\n```js\ncode\n```\n",
  "```\nunclosed\n",
  "prose `inline` only\n",
];

function parserBlocks(source: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  const walk = (node: MdNode) => {
    if (node.type === "code" && node.position) {
      blocks.push([node.position.start.line - 1, node.position.end.line - 1]);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(markdownToMdast(source) as MdNode);
  return blocks;
}

test("fencedBlocks finds the fenced code the Markdown parser finds", () => {
  for (const source of FIXTURES) {
    const lines = source.split("\n");
    // The parser runs an unclosed fence to the end of the document; the
    // scanner deliberately leaves it as prose, so compare closed fences only.
    const expected = parserBlocks(source).filter(([, end]) => /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.test(lines[end] ?? ""));
    const actual = fencedBlocks(lines).map((block): [number, number] => [block.open, block.close]);
    assert.deepEqual(actual, expected, source);
  }
});
