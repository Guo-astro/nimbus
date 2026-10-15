// Request rendering serves a collection where its route file is: `sdk` routed
// at `src/pages/products/kit/`, `cli` at `src/pages/cli/` with a kept copy at
// `src/pages/es/cli/`, with and without a `base`. (Request-rendered API
// pages need the Cloudflare adapter; `page-resolution.test.ts` covers their
// lookup by folder.) Hand-written
// request routes and the root docs route resolve as before, and a route under
// a folder no collection is served from is not found and reported.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { agentSites, siteApp, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");

const proseRoute = (getStaticPaths: string, render = "getCollectionPage(Astro)") => `---
import { getCollectionPage, getCollectionStaticPaths, getDocsPage, getDocsStaticPaths } from ${runtime};
${getStaticPaths}
const page = await ${render};
if (page instanceof Response) return page;
---
<html><body><main data-page={\`\${page.entry.collection}:\${page.entry.id}\`}>page</main></body></html>
`;

const FILES: Record<string, string> = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ base: "sdk" })),
  cli: defineCollection(docsCollection({ base: "cli" })),
  blog: defineCollection(docsCollection({ base: "blog" })),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
  "src/content/docs/guide.mdx": "---\ntitle: Guide\n---\nGuide.\n",
  "src/content/sdk/setup.mdx": "---\ntitle: Setup\n---\nSet it up.\n",
  "src/content/cli/install.mdx": "---\ntitle: Install\n---\nInstall it.\n",
  "src/content/blog/first.mdx": "---\ntitle: First\n---\nFirst.\n",
  "src/pages/[...slug].astro": proseRoute("export const getStaticPaths = getDocsStaticPaths;", "getDocsPage(Astro)"),
  "src/pages/products/kit/[...slug].astro": proseRoute(`export const getStaticPaths = getCollectionStaticPaths("sdk");`),
  "src/pages/cli/[...slug].astro": proseRoute(`export const getStaticPaths = getCollectionStaticPaths("cli");`),
  "src/pages/es/cli/[...slug].astro": proseRoute(`export const getStaticPaths = getCollectionStaticPaths("cli");`),
  "src/pages/blog/[...slug].astro": proseRoute(""),
  "src/pages/kits/[...slug].astro": proseRoute(""),
};

for (const base of ["/", "/docs"]) {
  test(`request rendering serves collections at their route's folder, base ${base}`, async () => {
    const site = await sites.buildSite(FILES, {
      packageImports: true,
      server: true,
      base,
      rendering: { default: "request", collections: { sdk: "request", cli: "request", blog: "request" } },
    });
    const app = await siteApp(site);
    const prefix = base === "/" ? "" : base;
    const page = async (pathname: string) => {
      const response = await app.render(new Request(`https://example.test${prefix}${pathname}`));
      return { status: response.status, page: /data-page="([^"]*)"/.exec(await response.text())?.[1] };
    };

    assert.deepEqual(await page("/products/kit/setup/"), { status: 200, page: "sdk:setup" });
    assert.deepEqual(await page("/cli/install/"), { status: 200, page: "cli:install" });
    assert.deepEqual(await page("/es/cli/install/"), { status: 200, page: "cli:install" });
    assert.deepEqual(await page("/blog/first/"), { status: 200, page: "blog:first" });
    assert.deepEqual(await page("/guide/"), { status: 200, page: "docs:guide" });
    assert.equal((await page("/sdk/setup/")).status, 404);

    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => void warnings.push(String(message));
    try {
      assert.equal((await page("/kits/setup/")).status, 404);
    } finally {
      console.warn = warn;
    }
    assert.ok(
      warnings.some((message) => /the route \/kits\/\[\.\.\.slug\] renders on request, but no page collection is served from \/kits/.test(message)),
      warnings.join("\n"),
    );
  });
}
