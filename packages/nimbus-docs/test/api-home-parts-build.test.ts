// The API home's later parts, end to end: a route that passes no
// `homeChunkSize` builds the home as one page, as before parts existed, and a
// built route that passes different sizes to its two helpers fails the build.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites, SMALLCO_SPEC, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");

const route = (staticPaths: string, routeOptions: string) => `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api"${staticPaths});
const result = await getApiRoute(Astro${routeOptions});
if (result instanceof Response) return result;
const parts = result.home?.parts.map((part) => part.href) ?? [];
---
<script type="application/json" data-parts set:html={JSON.stringify(parts)} />
`;

const files = (apiRoute: string) => ({
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(apiCollection()),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
  "src/pages/api/[...slug].astro": apiRoute,
});

const options = { packageImports: true, api: [{ collection: "api", spec: SMALLCO_SPEC }] };

async function homeParts(root: string): Promise<string[]> {
  const html = await readFile(path.join(root, "dist", "api", "index.html"), "utf8");
  return JSON.parse(/<script type="application\/json" data-parts>(.*?)<\/script>/.exec(html)![1]!);
}

// More endpoints than the starter's 150, so a default size would split them.
const largeSpec = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Large", version: "1" },
  paths: Object.fromEntries(
    Array.from({ length: 151 }, (_, n) => [
      `/things/${n}`,
      { get: { operationId: `get${n}`, responses: { "200": { description: "OK" } } } },
    ]),
  ),
});

test("without homeChunkSize, the home is one page with no later parts", async () => {
  const site = await sites.buildSite(
    { ...files(route("", "")), "src/api/large.json": largeSpec },
    { ...options, api: [{ collection: "api", spec: "./src/api/large.json" }] },
  );
  assert.deepEqual(await homeParts(site.root), ["/api/"]);
  assert.equal(existsSync(path.join(site.root, "dist", "api", "index", "2")), false);
});

test("the same homeChunkSize in both helpers builds every part", async () => {
  const site = await sites.buildSite(files(route(", { homeChunkSize: 2 }", ", { homeChunkSize: 2 }")), options);
  const parts = await homeParts(site.root);
  assert.ok(parts.length > 1);
  for (const href of parts.slice(1)) {
    assert.ok(existsSync(path.join(site.root, "dist", href, "index.html")), href);
  }
});

test("a built route with different sizes in its two helpers fails the build", async () => {
  await assert.rejects(
    sites.buildSite(files(route(", { homeChunkSize: 2 }", "")), options),
    /homeChunkSize is 2 in getApiStaticPaths\("api"\) but unset in getApiRoute\. Pass API_HOME_CHUNK_SIZE to both/,
  );
  await assert.rejects(
    sites.buildSite(files(route("", ", { homeChunkSize: 2 }")), options),
    /homeChunkSize is unset in getApiStaticPaths\("api"\) but 2 in getApiRoute\. Pass API_HOME_CHUNK_SIZE to both/,
  );
});
