import assert from "node:assert/strict";
import { test } from "node:test";

import { surfaceWarnings } from "../src/_internal/api/parse.js";

test("warnings that differ only by source print once, with the first source and a count", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => void lines.push(line));
  surfaceWarnings("api", [
    ...Array.from({ length: 1000 }, (_, i) => ({
      level: "warning" as const,
      message: "Example doesn't match its schema.",
      source: `paths./items/${i}.get`,
    })),
    { level: "warning" as const, message: "Another warning.", source: "paths./other.get" },
  ]);
  assert.deepEqual(lines, [
    "[nimbus:api:api] Example doesn't match its schema. (paths./items/0.get, ×1,000)",
    "[nimbus:api:api] Another warning. (paths./other.get)",
  ]);
});

test("the 20-line cap counts grouped lines", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => void lines.push(line));
  surfaceWarnings(
    "api",
    Array.from({ length: 30 }, (_, i) => ({ level: "warning" as const, message: `Warning ${i}.` })),
  );
  assert.equal(lines.length, 21);
  assert.equal(lines.at(-1), "[nimbus:api:api] …and 10 more warning(s).");
});
