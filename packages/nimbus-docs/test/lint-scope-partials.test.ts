// The lint scope's "Markdown pages not linted" note counts pages, not partials.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { pageCollectionLintScope } from "../src/lint/collection-scope.js";

test("a Markdown partial isn't counted as an unlinted page", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nimbus-lint-scope-"));
  try {
    const write = (rel: string, body: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    };
    write(
      "src/content.config.ts",
      [
        'import { defineCollection } from "astro:content";',
        'import { docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";',
        "export const collections = {",
        "  docs: defineCollection(docsCollection()),",
        "  partials: defineCollection(partialsCollection()),",
        "};",
      ].join("\n"),
    );
    write("src/content/docs/index.mdx", "# Home");
    write("src/content/docs/notes.md", "# Notes");
    write("src/content/partials/support-note.md", "Need help with {props.product}?");
    assert.deepEqual(pageCollectionLintScope(root).notes, ["1 Markdown (.md) page not linted: lint reads .mdx files."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
