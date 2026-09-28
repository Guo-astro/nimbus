import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { scanVersionFrontmatter } from "../src/_internal/scan-version-frontmatter.js";
import type { ResolvedVersions } from "../src/types.js";

test("a frontmatter slug is the entry id, as in Astro's glob loader", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-scan-versions-"));
  try {
    const write = (file: string, front: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), `---\n${front}\n---\n`);
    };
    write("src/content/docs/guides/install.mdx", "title: Install");
    write("src/content/docs-v1/guides/setup.mdx", "title: Setup\nslug: guides/install");
    write("src/content/docs-v1/1.2.3/notes.mdx", 'title: Notes\nslug: "1.2.3/notes" # keeps the dots');
    write("src/content/docs-v1/empty.mdx", "title: Empty\nslug:\ndraft: false");

    const entries = await scanVersionFrontmatter({
      projectRoot: root,
      versions: { others: ["v1"] } as unknown as ResolvedVersions,
    });
    const ids = entries.map((entry) => `${entry.collection}:${entry.id}`).sort();
    assert.deepEqual(ids, ["docs-v1:1.2.3/notes", "docs-v1:empty", "docs-v1:guides/install", "docs:guides/install"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
