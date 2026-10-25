import assert from "node:assert/strict";
import { test } from "node:test";

import { expandPreparedPartials } from "../src/_internal/build-partials.ts";

const partial = { id: "steps", collection: "partials", body: "First.\n\nSecond.", data: {} };
const expand = (source: string) =>
  expandPreparedPartials(source, { sourceId: "page.mdx", getPartial: () => partial });

test("a partial inside a list item or quote continues it", async () => {
  assert.equal(
    await expand('- Item\n\n  <Render file="steps" />\n'),
    "- Item\n\n  First.\n\n  Second.\n",
  );
  assert.equal(
    await expand('1. Step\n   <Render file="steps" />\n'),
    "1. Step\n   First.\n\n   Second.\n",
  );
  assert.equal(await expand('> <Render file="steps" />\n'), "> First.\n>\n> Second.\n");
  assert.equal(await expand('<Render file="steps" />\n'), "First.\n\nSecond.\n");
});

test("a partial with no body expands to nothing", async () => {
  assert.equal(
    await expandPreparedPartials('Before.\n\n<Render file="blank" />\n\nAfter.\n', {
      sourceId: "page.mdx",
      getPartial: () => ({ id: "blank", collection: "partials", body: "", data: {} }),
    }),
    "Before.\n\n\n\nAfter.\n",
  );
});
