// Sitemap `lastmod`: frontmatter first, git second, nothing for pages with no
// source; the site's `serialize` runs after Nimbus's; lookups never throw.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreparedMarkdownSnapshot } from "../src/_internal/prepared-markdown-registry.js";
import {
  createSitemapSerialize,
  sitemapRouteKey,
  sitemapSources,
} from "../src/_internal/sitemap-lastmod.js";

function snapshot(
  collections: Record<
    string,
    { role: "page" | "partials" | "api"; entries: Array<{ id: string; filePath?: string; data?: Record<string, unknown> }> }
  >,
): PreparedMarkdownSnapshot {
  return {
    revision: 1,
    collections: new Map(
      Object.entries(collections).map(([name, value]) => [
        name,
        {
          role: value.role,
          capability: { digest: "sha256:x" } as never,
          entries: new Map(
            value.entries.map((entry) => [
              entry.id,
              { id: entry.id, collection: name, data: entry.data ?? {}, filePath: entry.filePath },
            ]),
          ),
        },
      ]),
    ),
  };
}

const site = snapshot({
  docs: {
    role: "page",
    entries: [
      { id: "index", filePath: "src/content/docs/index.mdx" },
      { id: "guides/setup", filePath: "src/content/docs/guides/setup.mdx" },
      {
        id: "pricing",
        filePath: "src/content/docs/pricing.mdx",
        data: { lastUpdated: new Date("2024-01-15T00:00:00.000Z") },
      },
      { id: "changelog", filePath: "src/content/docs/changelog.mdx", data: { lastUpdated: "2024-02-01" } },
    ],
  },
  "docs-v1": { role: "page", entries: [{ id: "guides/setup", filePath: "src/content/docs-v1/guides/setup.mdx" }] },
  partials: { role: "partials", entries: [{ id: "note", filePath: "src/content/partials/note.mdx" }] },
  api: { role: "api", entries: [{ id: "users/list" }] },
});
const dates = {
  "src/content/docs/index.mdx": "2023-05-01T10:00:00.000Z",
  "src/content/docs/guides/setup.mdx": "2023-06-02T11:00:00.000Z",
  "src/content/docs/pricing.mdx": "2023-07-03T12:00:00.000Z",
  "src/content/docs-v1/guides/setup.mdx": "2022-01-01T00:00:00.000Z",
};

test("sitemapSources: page entries keyed by their base-aware route", () => {
  const sources = sitemapSources({
    snapshot: site,
    base: "/docs/",
    versions: { current: "v2", others: ["v1"] },
  });
  assert.deepEqual([...sources.keys()].sort(), [
    "/docs",
    "/docs/changelog",
    "/docs/guides/setup",
    "/docs/pricing",
    "/docs/v1/guides/setup",
  ]);
  assert.equal(sources.get("/docs/pricing")?.lastUpdated instanceof Date, true);
  assert.equal(sources.get("/docs/changelog")?.lastUpdated, "2024-02-01");
});

test("sitemapRouteKey: trailing slash, .html, encoding and base all normalise", () => {
  assert.equal(sitemapRouteKey("https://x.test/guides/setup/"), "/guides/setup");
  assert.equal(sitemapRouteKey("https://x.test/guides/setup"), "/guides/setup");
  assert.equal(sitemapRouteKey("https://x.test/guides/setup.html"), "/guides/setup");
  assert.equal(sitemapRouteKey("https://x.test/index.html"), "/");
  assert.equal(sitemapRouteKey("https://x.test/"), "/");
  assert.equal(sitemapRouteKey("https://x.test/%E6%8C%87%E5%8D%97/"), "/指南");
});

test("serialize: frontmatter wins, git is the fallback, no source means no lastmod", async () => {
  const serialize = createSitemapSerialize({
    sources: () => sitemapSources({ snapshot: site, base: "/" }),
    dates: () => dates,
  });
  const at = async (url: string) => (await serialize({ url }))?.lastmod;
  assert.equal(await at("https://x.test/pricing/"), "2024-01-15T00:00:00.000Z");
  assert.equal(await at("https://x.test/changelog/"), "2024-02-01T00:00:00.000Z");
  assert.equal(await at("https://x.test/guides/setup/"), "2023-06-02T11:00:00.000Z");
  assert.equal(await at("https://x.test/"), "2023-05-01T10:00:00.000Z");
  assert.equal(await at("https://x.test/api/users/list/"), undefined);
  assert.equal(await at("https://x.test/custom-page/"), undefined);
});

test("serialize: a shallow clone (empty index) sets no git lastmod but keeps frontmatter", async () => {
  const serialize = createSitemapSerialize({
    sources: () => sitemapSources({ snapshot: site, base: "/" }),
    dates: () => ({}),
  });
  assert.equal((await serialize({ url: "https://x.test/guides/setup/" }))?.lastmod, undefined);
  assert.equal((await serialize({ url: "https://x.test/pricing/" }))?.lastmod, "2024-01-15T00:00:00.000Z");
});

test("serialize: the site's serialize runs after Nimbus's and can override or drop", async () => {
  const seen: string[] = [];
  const serialize = createSitemapSerialize({
    sources: () => sitemapSources({ snapshot: site, base: "/" }),
    dates: () => dates,
    serialize: (item) => {
      seen.push(item.lastmod ?? "none");
      if (item.url.endsWith("/pricing/")) return null;
      if (item.url.endsWith("/changelog/")) return { ...item, lastmod: undefined };
      return { ...item, priority: 0.5 };
    },
  });
  assert.equal(await serialize({ url: "https://x.test/pricing/" }), null);
  assert.deepEqual(await serialize({ url: "https://x.test/changelog/" }), {
    url: "https://x.test/changelog/",
    lastmod: undefined,
  });
  assert.deepEqual(await serialize({ url: "https://x.test/guides/setup/" }), {
    url: "https://x.test/guides/setup/",
    lastmod: "2023-06-02T11:00:00.000Z",
    priority: 0.5,
  });
  assert.deepEqual(seen, ["2024-01-15T00:00:00.000Z", "2024-02-01T00:00:00.000Z", "2023-06-02T11:00:00.000Z"]);
});

test("serialize: a failing lookup leaves the entry alone instead of throwing", async () => {
  const serialize = createSitemapSerialize({
    sources: () => {
      throw new Error("no snapshot");
    },
    dates: () => dates,
  });
  assert.deepEqual(await serialize({ url: "https://x.test/guides/setup/" }), {
    url: "https://x.test/guides/setup/",
  });
});
