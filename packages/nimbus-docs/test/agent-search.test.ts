import assert from "node:assert/strict";
import { test } from "node:test";
import {
  documentationSearchTool,
  SEARCH_LIMITS,
  type DocumentationPagefind,
} from "../src/_internal/agent-search-contract.js";
import { createDocumentationSearch } from "../src/_internal/agent-search.js";

const page = (
  url = "/guide/#install",
  excerpt = "Use <mark>tokens</mark> &amp; keys.",
) => ({
  url,
  meta: { title: "Guide" },
  excerpt,
  sub_results: [{ title: "Install", url, excerpt }],
});

test("shared search schema and runtime reject invalid input before loading the index", async () => {
  const search = createDocumentationSearch(
    async () => {
      throw new Error("should not load");
    },
    { site: "https://example.com", versions: ["v1"] },
  );
  for (const input of [
    null,
    [],
    {},
    { query: " " },
    { query: "a".repeat(501) },
    { query: "x", limit: 0 },
    { query: "x", limit: 21 },
    { query: "x", limit: 1.5 },
    { query: "x", limit: "5" },
    { query: "x", version: "hidden" },
    { query: "x", surprise: true },
  ]) {
    assert.equal(
      ((await search(input)) as { error: { code: string } }).error.code,
      "invalid_input",
    );
  }
  assert.equal(documentationSearchTool("Nimbus").name, "search_documentation");
  assert.match(documentationSearchTool("Nimbus").description, /Nimbus/);
  assert.equal(
    "version" in documentationSearchTool("Nimbus").inputSchema.properties,
    false,
  );
  assert.deepEqual(
    documentationSearchTool("Nimbus", ["v1"]).inputSchema.properties.version
      ?.enum,
    ["v1"],
  );
});

test("default excludes deprecated; explicit visible version replaces that filter", async () => {
  const calls: unknown[] = [];
  const search = createDocumentationSearch(
    async () => ({
      search: async (query, options) => {
        calls.push([query, options]);
        return { results: [] };
      },
    }),
    { site: "https://example.com", versions: ["v2", "v1"] },
  );
  await search({ query: " tokens " });
  await search({ query: "tokens", version: "v1" });
  assert.deepEqual(calls, [
    ["tokens", { filters: { status: { none: ["deprecated"] } } }],
    ["tokens", { filters: { version: "v1" } }],
  ]);
});

test("section results decode text, cap Unicode excerpts, deduplicate URLs and stop loading at limit", async () => {
  let loaded = 0;
  const search = createDocumentationSearch(
    async () => ({
      search: async () => ({
        results: [
          {
            data: async () => ({
              ...page(),
              sub_results: [
                page().sub_results[0]!,
                page().sub_results[0]!,
                {
                  title: "Next",
                  url: "/docs/guide/#next",
                  excerpt: "😀".repeat(1200),
                },
              ],
            }),
          },
          {
            data: async () => {
              loaded++;
              return page();
            },
          },
        ],
      }),
    }),
    { site: "https://example.com", base: "/docs/" },
  );
  const response = await search({ query: "tokens", limit: 2 });
  assert.ok("results" in response);
  assert.deepEqual(response.results[0], {
    title: "Guide",
    heading: "Install",
    url: "https://example.com/docs/guide/#install",
    excerpt: "Use tokens & keys.",
  });
  assert.equal(
    response.results[1]?.url,
    "https://example.com/docs/guide/#next",
  );
  assert.equal(
    [...(response.results[1]?.excerpt ?? "")].length,
    SEARCH_LIMITS.excerpt,
  );
  assert.equal(loaded, 0);
});

test("errors hide exceptions; page-top results keep a valid top fragment", async () => {
  const options = { site: "https://example.com" };
  const unavailable = createDocumentationSearch(async () => {
    throw new Error("SECRET");
  }, options);
  assert.deepEqual(await unavailable({ query: "x" }), {
    error: {
      code: "index_unavailable",
      message: "Search index unavailable; run a build first.",
    },
  });
  for (const index of [
    {
      search: async () => {
        throw new Error("SECRET");
      },
    },
    {
      search: async () => ({
        results: [{ data: async () => page("https://evil.example/secret") }],
      }),
    },
  ] as DocumentationPagefind[]) {
    assert.deepEqual(
      await createDocumentationSearch(
        async () => index,
        options,
      )({ query: "x" }),
      {
        error: {
          code: "search_failed",
          message: "Documentation search failed. Try again.",
        },
      },
    );
  }
  const search = createDocumentationSearch(
    async () => ({
      search: async () => ({
        results: [
          { data: async () => ({ ...page("/guide/"), sub_results: [] }) },
        ],
      }),
    }),
    options,
  );
  assert.equal(
    ((await search({ query: "x" })) as { results: { url: string }[] })
      .results[0]?.url,
    "https://example.com/guide/#",
  );
});

test("concurrent calls do not cross-contaminate Pagefind fragment excerpts", async () => {
  let current = "";
  const search = createDocumentationSearch(
    async () => ({
      search: async (query) => {
        current = query;
        return {
          results: [
            {
              data: async () => {
                await new Promise((resolve) => setTimeout(resolve, 1));
                return page("/guide/#install", current);
              },
            },
          ],
        };
      },
    }),
    { site: "https://example.com" },
  );
  const results = await Promise.all([
    search({ query: "one" }),
    search({ query: "two" }),
  ]);
  assert.deepEqual(
    results.map((result) => "results" in result && result.results[0]?.excerpt),
    ["one", "two"],
  );
});
