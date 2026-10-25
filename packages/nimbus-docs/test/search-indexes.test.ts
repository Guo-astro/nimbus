/**
 * Tests for `client/search-indexes.ts`: only the bundles that answer are
 * merged, so a slice of several collections (whose other bundle URLs 404)
 * keeps a working search.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeSearchIndexes } from "../src/client/search-indexes.js";

test("mergeSearchIndexes merges the bundles that exist and skips the rest", async () => {
  const g = globalThis as any;
  const prev = { location: g.location, fetch: g.fetch };
  const requested: string[] = [];
  g.location = { origin: "https://docs.example" };
  g.fetch = async (url: URL) => {
    requested.push(url.href);
    if (url.pathname.startsWith("/manual/offline/")) throw new TypeError("network");
    return { ok: url.pathname.startsWith("/manual/api/") };
  };
  const mergedCalls: Array<[string, unknown]> = [];
  try {
    const merged = await mergeSearchIndexes(
      { mergeIndex: async (url, options) => void mergedCalls.push([url, options]) },
      ["/manual/api/pagefind/", "/manual/remote/pagefind/", "/manual/offline/pagefind/"],
      { baseUrl: "/manual/" },
    );
    assert.deepEqual(requested, [
      "https://docs.example/manual/api/pagefind/pagefind-entry.json",
      "https://docs.example/manual/remote/pagefind/pagefind-entry.json",
      "https://docs.example/manual/offline/pagefind/pagefind-entry.json",
    ]);
    assert.deepEqual(merged, ["https://docs.example/manual/api/pagefind/"]);
    assert.deepEqual(mergedCalls, [["https://docs.example/manual/api/pagefind/", { baseUrl: "/manual/" }]]);
  } finally {
    g.location = prev.location;
    g.fetch = prev.fetch;
  }
});
