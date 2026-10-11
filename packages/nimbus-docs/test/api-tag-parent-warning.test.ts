// A tag's `parent` (OpenAPI 3.2) is honoured whatever version a spec declares,
// so validation doesn't warn about it; other deviations still warn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApiModel } from "../src/api/index.js";

async function warningsFor(openapi: string): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    await buildApiModel({
      collection: `tag-parent-${openapi.replaceAll(".", "-")}`,
      spec: {
        openapi,
        info: { title: "Tags", version: "1" },
        tags: [{ name: "zones" }, { name: "dns", parent: "zones" }, { name: "rules", parent: "zones", bogus: true }],
        paths: { "/dns": { get: { operationId: "listDns", tags: ["dns"], responses: { "200": { description: "OK" } } } } },
      },
    });
  } finally {
    console.warn = original;
  }
  return warnings;
}

for (const openapi of ["3.0.3", "3.1.0", "3.2.0"]) {
  test(`OpenAPI ${openapi}: no warning for tag parent, other deviations still warn`, async () => {
    const warnings = await warningsFor(openapi);
    assert.ok(!warnings.some((w) => w.includes("Property parent")), warnings.join("\n"));
    if (openapi !== "3.2.0") assert.ok(warnings.some((w) => w.includes("Property bogus")), warnings.join("\n"));
  });
}
