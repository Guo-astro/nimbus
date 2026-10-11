import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiBuildError } from "../src/_internal/api/coordinates.js";
import { authorError, withApiErrorsAsAuthorErrors } from "../src/_internal/author-error.js";
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

test("an API spec failure in config setup becomes an author error; anything else passes through", async () => {
  const spec = new ApiBuildError([{ level: "error", message: "Swagger 2.0 isn't supported.", source: "./api.yaml" }]);
  const converted = await withApiErrorsAsAuthorErrors(() => Promise.reject(spec)).catch((err: Error) => err);
  assert.ok(!(converted instanceof ApiBuildError));
  assert.equal(converted.stack, "");
  assert.equal(converted.cause, undefined);
  assert.equal(converted.message, spec.message);

  const other = new Error("boom");
  assert.equal(await withApiErrorsAsAuthorErrors(() => Promise.reject(other)).catch((err: Error) => err), other);
});
