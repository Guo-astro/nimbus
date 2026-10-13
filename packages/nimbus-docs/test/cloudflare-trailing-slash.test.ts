import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cloudflareTrailingSlashWarning } from "../src/_internal/cloudflare-trailing-slash.js";

const redirecting = { output: "static", trailingSlash: "always", format: "file" };

function withWrangler(body: string | null, run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "nimbus-trailing-slash-"));
  try {
    if (body !== null) writeFileSync(path.join(root, "wrangler.jsonc"), body);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("static Cloudflare site linking /page/ to page.html files: warns with the setting", () => {
  withWrangler('{\n  // static\n  "name": "docs",\n  "assets": { "directory": "./dist" },\n}\n', (root) => {
    const warning = cloudflareTrailingSlashWarning(root, redirecting);
    assert.match(warning ?? "", /redirects every \/page\/ link to \/page/);
    assert.match(warning ?? "", /"html_handling": "force-trailing-slash" \} in wrangler\.jsonc/);
  });
});

test("no warning once force-trailing-slash is set, or when nothing redirects", () => {
  withWrangler('{ "assets": { "directory": "./dist", "html_handling": "force-trailing-slash" } }', (root) => {
    assert.equal(cloudflareTrailingSlashWarning(root, redirecting), null);
  });
  withWrangler('{ "assets": { "directory": "./dist" } }', (root) => {
    // `directory` writes page/index.html, which Cloudflare serves at /page/.
    assert.equal(cloudflareTrailingSlashWarning(root, { ...redirecting, format: "directory" }), null);
    assert.equal(cloudflareTrailingSlashWarning(root, { ...redirecting, trailingSlash: "ignore" }), null);
    assert.equal(cloudflareTrailingSlashWarning(root, { ...redirecting, output: "server" }), null);
  });
  withWrangler(null, (root) => {
    assert.equal(cloudflareTrailingSlashWarning(root, redirecting), null);
  });
});
