import assert from "node:assert/strict";
import { test } from "node:test";

import { authorError } from "../src/_internal/author-error.js";
import { formatFailures } from "../src/_internal/validate-mdx-content.js";

test("content errors reach Astro as user errors without a stack", () => {
  const message = formatFailures([
    { filePath: "src/content/docs/guide.mdx", line: 5, column: 1, tag: "Foo", hint: null },
  ]);
  const error = authorError(message, "Register the component.") as Error & { type?: string; hint?: string };
  // Astro prints `[name] message` and the hint for these, and a stack only when there is one.
  assert.equal(error.type, "AstroUserError");
  assert.equal(error.message, message);
  assert.equal(error.hint, "Register the component.");
  assert.equal(error.stack, "");
});
