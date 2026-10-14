import assert from "node:assert/strict";
import { test } from "node:test";

import { publishOpenApiSpec } from "../src/_internal/api/publish-spec.js";

test("concurrent spec publication preserves application warnings", async () => {
  const source = {
    openapi: "3.0.3",
    info: { title: "Example", version: "1.0.0" },
    paths: {},
  };
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const results = await Promise.all([
      publishOpenApiSpec(source, process.cwd()),
      publishOpenApiSpec(source, process.cwd()),
    ]);
    for (const result of results) {
      assert.equal(result.error, undefined);
      assert.ok(result.spec);
    }
    console.warn("Application warning after spec publication");
    assert.deepEqual(warnings, [
      ["Application warning after spec publication"],
    ]);
  } finally {
    console.warn = originalWarn;
  }
});
