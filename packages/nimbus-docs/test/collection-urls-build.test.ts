// A collection served where its route file is, end to end: `sdk` routed at
// `src/pages/products/kit/` (a folder that doesn't match its name) and an API
// collection at `src/pages/reference/api/`. Every surface Nimbus builds a URL
// for uses the route's folder, and nothing lands at the default URL.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { agentManifest, agentSites, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");
const endpoints = srcModule("agent-endpoints.ts");
const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Pets", version: "1.0.0" },
  paths: { "/pets": { get: { operationId: "list-pets", summary: "List pets", responses: { "200": { description: "ok" } } } } },
});

const FILES: Record<string, string> = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ base: "sdk" })),
  cli: defineCollection(docsCollection({ base: "cli" })),
  api: defineCollection(apiCollection()),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome. See [setup](/products/kit/setup).\n",
  "src/content/sdk/index.mdx": "---\ntitle: SDK\n---\nThe SDK.\n",
  "src/content/sdk/setup.mdx": "---\ntitle: Setup\n---\nSet it up.\n",
  "src/content/sdk/usage.mdx": "---\ntitle: Usage\n---\nUse it.\n",
  "src/content/cli/install.mdx": "---\ntitle: Install\n---\nInstall it.\n",
  "specs/v2.json": SPEC,
  "specs/v1.json": SPEC,
  "src/pages/[...slug].astro": `---
import { getDocsStaticPaths, getDocsPage } from ${runtime};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const page = await getDocsPage(Astro);
if (page instanceof Response) return page;
---
<html><body>doc</body></html>
`,
  "src/pages/products/kit/[...slug].astro": `---
import { getBreadcrumbs, getCollectionStaticPaths, getCollectionPage, getCollectionUrl, getIndexedTopLevel, getPrevNext, getSidebar, stripBase } from ${runtime};
const slug = stripBase(Astro.url.pathname, import.meta.env.BASE_URL).replace(/[/]$/, "") || "/";
export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("sdk");
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
const sidebar = await getSidebar(slug, { collection: "sdk" });
const hrefs = [];
const walk = (items) => { for (const item of items) { if (item.href) hrefs.push(item.href); walk(item.children ?? []); } };
walk(sidebar);
const crumbs = await getBreadcrumbs(slug, { collection: "sdk" });
const { prev, next } = await getPrevNext(slug, { sidebarTree: sidebar });
const typo = await getCollectionUrl("skd").then(() => "", (error) => error.message);
const links = [...crumbs.map((crumb) => crumb.href), prev?.href, next?.href, page.ogImageUrl].filter(Boolean);
---
<html><body><main data-links={JSON.stringify(links)} data-groups={JSON.stringify((await getIndexedTopLevel()).groups.map((group) => group.slug))} data-url={await getCollectionUrl("sdk")} data-typo={typo} data-md={page.markdownUrl} data-sidebar={JSON.stringify(hrefs)}>sdk</main></body></html>
`,
  "src/pages/products/kit/cli/[...slug].astro": `---
import { getCollectionStaticPaths, getCollectionPage } from ${runtime};
export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("cli");
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
---
<html><body><main data-md={page.markdownUrl}>cli</main></body></html>
`,
  "src/pages/reference/api/[...slug].astro": `---
import { getApiRoute, getApiStaticPaths } from ${runtime};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
---
<html><body>{result.page.title}</body></html>
`,
  "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${endpoints};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
`,
  "src/pages/llms.txt.ts": `import { llmsRoute } from ${endpoints};
export const prerender = true;
export const { GET } = llmsRoute();
`,
  "src/pages/llms-full.txt.ts": `import { llmsFullRoute } from ${endpoints};
export const prerender = true;
export const { GET } = llmsFullRoute();
`,
  "src/pages/[...section]/llms.txt.ts": `import { llmsSectionRoute } from ${endpoints};
export const prerender = true;
export const { GET, getStaticPaths } = llmsSectionRoute();
`,
};

let root: string;

before(async () => {
  ({ root } = await sites.buildSite(FILES, {
    packageImports: true,
    sitemap: true,
    sidebar: { items: [{ autogenerate: { collection: "docs" } }, { label: "SDK", items: [{ autogenerate: { collection: "sdk" } }] }] },
    api: [
      {
        collection: "api",
        versions: [
          { version: "v2", spec: "./specs/v2.json", default: true },
          { version: "v1", spec: "./specs/v1.json" },
        ],
      },
    ],
  }));
});
after(() => sites.cleanup());

const read = (file: string) => readFile(path.join(root, "dist", file), "utf8");
const exists = (file: string) => existsSync(path.join(root, "dist", file));

test("a prose collection is served at its route's folder, on every surface", async () => {
  assert.ok(exists("products/kit/setup/index.html"));
  assert.ok(exists("products/kit/setup/index.md"));
  assert.ok(!exists("sdk"), "nothing at the default URL");
  const html = await read("products/kit/setup/index.html");
  assert.match(html, /data-url="\/products\/kit\/"/);
  assert.match(html, /data-typo="nimbus-docs: getCollectionUrl\(&quot;skd&quot;\): no page collection is named &quot;skd&quot;\. Page collections: [^"]*sdk/);
  assert.match(html, /data-md="\/products\/kit\/setup\/index\.md"/);
  const sidebar = JSON.parse(/data-sidebar="([^"]*)"/.exec(html)![1]!.replaceAll("&quot;", '"')) as string[];
  assert.ok(sidebar.length > 0);
  assert.ok(sidebar.every((href) => href.startsWith("/products/kit")), sidebar.join(", "));
  const links = JSON.parse(/data-links="([^"]*)"/.exec(html)![1]!.replaceAll("&quot;", '"')) as string[];
  // Breadcrumbs (after Home), previous and next, and the social card.
  assert.deepEqual(links, ["/", "/products/kit/setup/", "/products/kit/usage/", "/og/products/kit/setup.png"]);
  const groups = JSON.parse(/data-groups="([^"]*)"/.exec(html)![1]!.replaceAll("&quot;", '"')) as string[];
  assert.ok(groups.includes("products/kit") && groups.includes("products/kit/cli") && !groups.includes("sdk"), groups.join(", "));

  const sections = (await agentManifest(root)).llmsAssets.filter((asset) => asset.scope === "section").map((asset) => asset.section);
  assert.ok(sections.includes("products/kit"), sections.join(", "));
  assert.match(await read("products/kit/llms.txt"), /https:\/\/example\.test\/docs\/products\/kit\/setup\/index\.md/);
  assert.match(await read("llms.txt"), /https:\/\/example\.test\/docs\/products\/kit\/llms\.txt/);
  assert.doesNotMatch(await read("llms.txt"), /\/docs\/sdk\//);
});

test("the sitemap lists a moved collection's pages at its route's folder", async () => {
  const sitemap = await read("sitemap-0.xml");
  assert.match(sitemap, /<loc>https:\/\/example\.test\/docs\/products\/kit\/setup\/<\/loc>/);
  assert.doesNotMatch(sitemap, /\/docs\/sdk\//);
});

test("a collection nested inside another's URL builds its own pages there", async () => {
  assert.ok(exists("products/kit/cli/install/index.html"));
  assert.match(await read("products/kit/cli/install/index.html"), /data-md="\/products\/kit\/cli\/install\/index\.md"/);
  assert.ok(exists("products/kit/cli/install/index.md"));
  assert.ok(!exists("cli"));
});

test("an API collection is served at its route's folder, versions, spec and catalog included", async () => {
  assert.ok(exists("reference/api/index.html"));
  assert.ok(exists("reference/api/v1/index.html"));
  assert.ok(exists("reference/api/openapi.json"));
  assert.ok(exists("reference/api/v1/openapi.json"));
  assert.ok(!exists("api"));
  const catalog = JSON.parse(await read(".well-known/api-catalog")) as { linkset: Array<{ anchor: string }> };
  assert.deepEqual(catalog.linkset.map((entry) => entry.anchor).sort(), [
    "https://example.test/docs/reference/api/",
    "https://example.test/docs/reference/api/v1/",
  ]);
});

test("every URL the agent files and the page link to is a route the build serves", async () => {
  const truth = JSON.parse(await readFile(path.join(root, ".nimbus/routes.json"), "utf8")) as { knownRoutes: string[]; mounts: Record<string, string> };
  assert.equal(truth.mounts.sdk, "/products/kit", "lint maps links into a moved collection through the recorded mounts");
  const known = new Set(truth.knownRoutes);
  const llmsFiles = (await readdir(path.join(root, "dist"), { recursive: true })).filter((file) => file.endsWith("llms.txt"));
  assert.ok(llmsFiles.length >= 4, llmsFiles.join(", "));
  const urls: string[] = [];
  for (const file of llmsFiles)
    for (const [, url] of (await read(file)).matchAll(/\(https:\/\/example\.test\/docs(\/[^)]*)\)/gu)) urls.push(url!);
  const html = await read("products/kit/setup/index.html");
  for (const attribute of ["data-sidebar", "data-links"])
    urls.push(...(JSON.parse(new RegExp(`${attribute}="([^"]*)"`).exec(html)![1]!.replaceAll("&quot;", '"')) as string[]));
  urls.push(/data-md="([^"]*)"/.exec(html)![1]!);
  const pages = urls.filter((url) => !url.startsWith("/og/"));
  assert.ok(pages.length > 8);
  const missing = pages.map((url) => url.replace(/\/$/u, "") || "/").filter((url) => !known.has(url) && !known.has(`${url}/`));
  assert.deepEqual(missing, []);
});

test("with a [section] llms.txt route, the root index lists a nested collection's pages instead of its llms.txt", async () => {
  const { "src/pages/[...section]/llms.txt.ts": nested, ...rest } = FILES;
  const { root: single } = await sites.buildSite(
    { ...rest, "src/pages/[section]/llms.txt.ts": nested! },
    { packageImports: true, api: [{ collection: "api", spec: "./specs/v2.json" }] },
  );
  const index = await readFile(path.join(single, "dist/llms.txt"), "utf8");
  assert.match(index, /https:\/\/example\.test\/docs\/products\/kit\/setup\/index\.md/);
  assert.doesNotMatch(index, /products\/kit\/llms\.txt/);
  assert.ok(!existsSync(path.join(single, "dist/products/kit/llms.txt")));
  const known = new Set((JSON.parse(await readFile(path.join(single, ".nimbus/routes.json"), "utf8")) as { knownRoutes: string[] }).knownRoutes);
  const urls = [...index.matchAll(/\(https:\/\/example\.test\/docs(\/[^)]*)\)/gu)].map(([, url]) => url!.replace(/\/$/u, "") || "/");
  assert.deepEqual(urls.filter((url) => !known.has(url) && !known.has(`${url}/`)), []);
});

test("partial builds write a moved collection's slice and its agent files at its route's folder", async () => {
  const build = async (only: string) => {
    process.env.NIMBUS_BUILD_ONLY = only;
    try {
      return (await sites.buildSite(FILES, { packageImports: true, api: [{ collection: "api", spec: "./specs/v2.json" }] })).root;
    } finally {
      delete process.env.NIMBUS_BUILD_ONLY;
    }
  };
  const slice = await build("sdk");
  assert.ok(existsSync(path.join(slice, "dist/products/kit/setup/index.html")));
  assert.ok(!existsSync(path.join(slice, "dist/sdk")));
  assert.match(await readFile(path.join(slice, "dist/products/kit/llms-full.txt"), "utf8"), /Set it up\./);
  const rootSlice = await build("docs");
  const index = await readFile(path.join(rootSlice, "dist/llms.txt"), "utf8");
  assert.match(index, /\(https:\/\/example\.test\/docs\/products\/kit\/llms\.txt\)/);
  assert.match(index, /Other parts have their own: .*https:\/\/example\.test\/docs\/products\/kit\/llms-full\.txt/);
  assert.doesNotMatch(index, /\/docs\/sdk\//);

  // With a [section] route, the root slice links the nested collection's
  // llms-full.txt, which its slice serves, not an llms.txt nothing serves.
  const { "src/pages/[...section]/llms.txt.ts": nested, ...rest } = FILES;
  process.env.NIMBUS_BUILD_ONLY = "docs";
  try {
    const { root: single } = await sites.buildSite(
      { ...rest, "src/pages/[section]/llms.txt.ts": nested! },
      { packageImports: true, api: [{ collection: "api", spec: "./specs/v2.json" }] },
    );
    const singleIndex = await readFile(path.join(single, "dist/llms.txt"), "utf8");
    assert.match(singleIndex, /\(https:\/\/example\.test\/docs\/products\/kit\/llms-full\.txt\)/);
    assert.doesNotMatch(singleIndex, /products\/kit\/llms\.txt/);
    assert.match(singleIndex, /\(https:\/\/example\.test\/docs\/reference\/api\/llms-full\.txt\)/);
  } finally {
    delete process.env.NIMBUS_BUILD_ONLY;
  }
});

test("a site without docs serves another collection at the root, grouped like docs in every index", async () => {
  const { root: site } = await sites.buildSite(
    {
      "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = { guides: defineCollection(docsCollection({ base: "guides" })) };`,
      "src/content/guides/index.mdx": "---\ntitle: Home\n---\nHome.\n",
      "src/content/guides/topic/one.mdx": "---\ntitle: One\n---\nOne.\n",
      "src/content/guides/topic/two.mdx": "---\ntitle: Two\n---\nTwo.\n",
      "src/pages/[...slug].astro": `---
import { getCollectionStaticPaths, getCollectionPage, getCollectionLlmsUrl, getIndexedTopLevel } from ${runtime};
export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("guides");
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
const { groups } = await getIndexedTopLevel();
---
<html><body><main data-llms={await getCollectionLlmsUrl("guides")} data-groups={JSON.stringify(groups.map((group) => group.slug))}>guides</main></body></html>
`,
      "src/pages/llms.txt.ts": FILES["src/pages/llms.txt.ts"]!,
      "src/pages/[...section]/llms.txt.ts": FILES["src/pages/[...section]/llms.txt.ts"]!,
    },
    { packageImports: true },
  );
  const html = await readFile(path.join(site, "dist/topic/one/index.html"), "utf8");
  assert.match(html, /data-llms="\/llms\.txt"/);
  assert.match(html, /data-groups="\[&quot;topic&quot;\]"/);
  const index = await readFile(path.join(site, "dist/llms.txt"), "utf8");
  assert.match(index, /\(https:\/\/example\.test\/docs\/topic\/llms\.txt\)/);
  assert.doesNotMatch(index, /\/guides\//);
  assert.ok(!existsSync(path.join(site, "dist/guides")));
});
