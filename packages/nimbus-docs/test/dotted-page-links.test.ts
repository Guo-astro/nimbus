import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree } from "../src/_internal/sidebar.js";
import { buildVersionAlternates } from "../src/_internal/version-alternates.js";

// Astro builds these as <path>/index.html, so they're pages, not files.
test("a page whose last segment has a dot gets a page link", () => {
  const tree = buildSidebarTree(
    { docs: [{ id: "frameworks/next.js", data: { title: "Next.js" } }] } as never,
    "docs",
    "frameworks/next.js",
  );
  assert.match(JSON.stringify(tree), /"href":"\/frameworks\/next\.js\/"/);
});

test("a dotted version name gets a page link to its landing", () => {
  const table = buildVersionAlternates(
    { current: "3.x", others: ["2.x"], deprecated: [], hidden: [], all: ["3.x", "2.x"] },
    [
      { collection: "docs", id: "index" },
      { collection: "docs-2.x", id: "index" },
    ],
  );
  const urls = table["docs:index"]?.alternates.map((alternate) => alternate.url);
  assert.ok(urls?.includes("/2.x/"), JSON.stringify(urls));
});
