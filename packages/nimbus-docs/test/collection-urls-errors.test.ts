// The errors a route can raise about where its collection is served, end to
// end: at setup, after content sync, and from the route guard at render.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");
const DOCS_LINK = /See https:\/\/nimbus-docs\.com\/writing\/pages-and-routing\/#collection-urls\./;

const base: Record<string, string> = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ base: "sdk" })),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
  "src/content/sdk/setup.mdx": "---\ntitle: Setup\n---\nSet it up.\n",
};

const sdkRoute = (getStaticPaths: string, imports = `import { getCollectionStaticPaths, getCollectionPage } from ${runtime};`) => `---
${imports}
export const prerender = true;
${getStaticPaths}
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
---
<html><body>sdk</body></html>
`;
const routed = sdkRoute(`export const getStaticPaths = getCollectionStaticPaths("sdk");`);

test("two routes for one collection fail at setup, naming both files", async () => {
  await assert.rejects(
    sites.buildSite(
      { ...base, "src/pages/a/[...slug].astro": routed, "src/pages/b/[...slug].astro": routed },
      { packageImports: true },
    ),
    (error: Error) => {
      assert.match(error.message, /src\/pages\/a\/\[\.\.\.slug\]\.astro/);
      assert.match(error.message, /src\/pages\/b\/\[\.\.\.slug\]\.astro/);
      assert.match(error.message, DOCS_LINK);
      return true;
    },
  );
});

test("a docs page under a moved collection's URL fails after sync", async () => {
  await assert.rejects(
    sites.buildSite(
      {
        ...base,
        "src/content/docs/products/kit/overview.mdx": "---\ntitle: Overview\n---\nTaken.\n",
        "src/pages/products/kit/[...slug].astro": routed,
      },
      { packageImports: true },
    ),
    (error: Error) => {
      assert.match(error.message, /docs page .*products\/kit\/overview/);
      assert.match(error.message, DOCS_LINK);
      return true;
    },
  );
});

test("the guard stops a helper the build didn't see from serving a collection at another folder", async () => {
  // The wrapper lives in another module, so the build can't tell this route
  // serves `sdk`: `sdk` stays at /sdk, and the route under /wrong is refused.
  const files = {
    ...base,
    "src/lib/paths.ts": `import { getCollectionStaticPaths } from ${runtime};\nexport const sdkPaths = getCollectionStaticPaths("sdk");\n`,
    "src/pages/wrong/[...slug].astro": sdkRoute(
      `export const getStaticPaths = sdkPaths;`,
      `import { getCollectionPage } from ${runtime};\nimport { sdkPaths } from "../../lib/paths";`,
    ),
  };
  await assert.rejects(sites.buildSite(files, { packageImports: true }), (error: Error) => {
    assert.match(error.message, /getCollectionStaticPaths\("sdk"\) runs in a route under \/wrong, but "sdk" is served from \/sdk/);
    assert.match(error.message, DOCS_LINK);
    return true;
  });
  // The same wrapper at the default folder is fine.
  const { "src/pages/wrong/[...slug].astro": route, ...rest } = files;
  const { root } = await sites.buildSite({ ...rest, "src/pages/sdk/[...slug].astro": route }, { packageImports: true });
  assert.ok(existsSync(path.join(root, "dist/sdk/setup/index.html")));
});

test("a helper route the build couldn't read is named at render", async () => {
  const files = {
    ...base,
    "src/lib/wrap.ts": `export const wrap = (paths) => (options) => paths(options);\n`,
    "src/pages/products/kit/[...slug].astro": sdkRoute(
      `export const getStaticPaths = wrap(getCollectionStaticPaths("sdk"));`,
      `import { getCollectionStaticPaths, getCollectionPage } from ${runtime};\nimport { wrap } from "../../../lib/wrap";`,
    ),
  };
  await assert.rejects(sites.buildSite(files, { packageImports: true }), (error: Error) => {
    assert.match(
      error.message,
      /couldn't read the getStaticPaths in src\/pages\/products\/kit\/\[\.\.\.slug\]\.astro, so "sdk" is still served from \/sdk/,
    );
    assert.match(error.message, DOCS_LINK);
    return true;
  });
});

test("a moved collection rendered on request fails at setup until request rendering supports it", async () => {
  await assert.rejects(
    sites.buildSite(
      { ...base, "src/pages/products/kit/[...slug].astro": routed },
      { packageImports: true, server: true, rendering: { default: "build", collections: { sdk: "request" } } },
    ),
    (error: Error) => {
      assert.match(error.message, /collection "sdk" renders on request from src\/pages\/products\/kit\/\[\.\.\.slug\]\.astro/);
      assert.match(error.message, DOCS_LINK);
      return true;
    },
  );
});
