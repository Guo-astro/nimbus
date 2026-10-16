// Request rendering serves a collection where its route file is: `sdk` routed
// at `src/pages/products/kit/`, `cli` at `src/pages/cli/` with a kept copy at
// `src/pages/es/cli/`, with and without a `base`. (Request-rendered API
// pages at a nested URL are in `api-query-versions-build.test.ts`.)
// Hand-written request routes and the root docs route resolve as before, a
// route under a folder no collection is served from is not found and
// reported, and the nested collection's Markdown and llms.txt follow its
// mode, through Nimbus's routes or the site's own.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites, siteApp, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");
const endpoints = JSON.stringify("@cloudflare/nimbus-docs/agent-endpoints");

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

for (const ownRoute of [false, true]) {
  test(`a nested request-rendered collection serves its Markdown and llms.txt on request${ownRoute ? ", from its own Markdown route" : ""}`, async () => {
    const agentRoute = (factory: string, exports: string) =>
      `import { ${factory} } from ${endpoints};\nexport const prerender = true;\nexport const { ${exports} } = ${factory}();\n`;
    const site = await sites.buildSite(
      {
        "src/content.config.ts": FILES["src/content.config.ts"]!,
        "src/content/docs/index.mdx": FILES["src/content/docs/index.mdx"]!,
        "src/content/docs/guide.mdx": FILES["src/content/docs/guide.mdx"]!,
        "src/content/sdk/setup.mdx": FILES["src/content/sdk/setup.mdx"]!,
        "src/content/cli/install.mdx": FILES["src/content/cli/install.mdx"]!,
        "src/content/blog/first.mdx": FILES["src/content/blog/first.mdx"]!,
        "src/pages/[...slug].astro": FILES["src/pages/[...slug].astro"]!,
        "src/pages/products/kit/[...slug].astro": FILES["src/pages/products/kit/[...slug].astro"]!,
        "src/pages/llms.txt.ts": agentRoute("llmsRoute", "GET"),
        "src/pages/[...section]/llms.txt.ts": agentRoute("llmsSectionRoute", "GET, getStaticPaths"),
        "src/pages/[...slug]/index.md.ts": agentRoute("markdownRoute", "GET, getStaticPaths"),
        ...(ownRoute
          ? { "src/pages/products/kit/[...slug]/index.md.ts": agentRoute("markdownRoute", "GET, getStaticPaths") }
          : {}),
      },
      { packageImports: true, server: true, base: "/", rendering: { default: "build", collections: { sdk: "request" } } },
    );
    const app = await siteApp(site);
    assert.ok(existsSync(path.join(site.root, "dist/guide/index.md")));
    for (const url of ["/products/kit/setup/index.md", "/products/kit/llms.txt"]) {
      assert.ok(!existsSync(path.join(site.root, "dist", url)), url);
      const response = await app.render(new Request(`https://example.test${url}`));
      assert.equal(response.status, 200, url);
      assert.match(await response.text(), /Set(up| it up)/, url);
    }
  });
}

test("a request-rendered collection's index is listed at the collection's URL, not /index", async () => {
  const site = await sites.buildSite(
    {
      "src/content.config.ts": FILES["src/content.config.ts"]!,
      "src/content/docs/index.mdx": FILES["src/content/docs/index.mdx"]!,
      "src/content/sdk/index.mdx": "---\ntitle: SDK\n---\nThe SDK.\n",
      "src/content/sdk/setup.mdx": FILES["src/content/sdk/setup.mdx"]!,
      "src/pages/[...slug].astro": FILES["src/pages/[...slug].astro"]!,
      "src/pages/products/kit/[...slug].astro": FILES["src/pages/products/kit/[...slug].astro"]!,
    },
    { packageImports: true, server: true, sitemap: true, rendering: { default: "request", collections: { sdk: "request" } } },
  );
  const sitemapFile = readdirSync(path.join(site.root, "dist"), { recursive: true, encoding: "utf8" }).find((file) => file.endsWith("sitemap-0.xml"))!;
  const sitemap = readFileSync(path.join(site.root, "dist", sitemapFile), "utf8");
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => new URL(match[1]!).pathname);
  assert.ok(locs.includes("/docs/products/kit/") && !locs.some((loc) => loc.endsWith("/index/")), locs.join(", "));
  const { knownRoutes } = JSON.parse(readFileSync(path.join(site.root, ".nimbus/routes.json"), "utf8")) as { knownRoutes: string[] };
  assert.ok(knownRoutes.includes("/products/kit") && !knownRoutes.includes("/products/kit/index"), knownRoutes.join(", "));
});
