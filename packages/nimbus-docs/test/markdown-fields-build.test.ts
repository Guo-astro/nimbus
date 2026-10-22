// markdownFields through real builds: rebuilding in place with the caches
// picks up an added, reordered or removed list, and a request-rendered site
// serves the same Markdown (read from the same baked assets; how a Worker
// reads them is covered in agent-endpoint-assets.test.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import { agentSites, siteApp } from "./fixtures/agent-site.ts";

const sites = agentSites();
afterEach(() => sites.cleanup());

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);

const config = (fields?: string[]) => `import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  changelog: defineCollection(
    docsCollection({
      base: "changelog",
      schemaFields: { date: z.coerce.date(), version: z.string().optional(), tags: z.array(z.string()).default([]) },
      ${fields ? `markdownFields: ${JSON.stringify(fields)},` : ""}
    }),
  ),
};`;

const routes = (prerender: boolean) => ({
  "src/pages/[...slug]/index.md.ts": `import { markdownRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
${prerender ? "export const prerender = true;\n" : ""}export const { GET, getStaticPaths } = markdownRoute();
`,
  "src/pages/[...slug]/index.mdx.ts": `import { markdownSourceRoute } from ${moduleUrl("../src/agent-endpoints.ts")};
${prerender ? "export const prerender = true;\n" : ""}export const { GET, getStaticPaths } = markdownSourceRoute();
`,
});

const content = {
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome body.\n",
  "src/content/changelog/2026-07-02-batch.md":
    '---\ntitle: Batch\ndate: 2026-07-02\nversion: "2.4.0"\ntags: [api, "forecasts"]\n---\n\n## New\n\nBatch forecasts.\n',
  "src/pages/index.astro": "---\nexport const prerender = true;\n---\n<h1>Home</h1>",
};

// A page route; the request-rendered changelog's Markdown is served beside it.
const proseRoute = (getStaticPaths: string, render = 'getCollectionPage(Astro, "changelog")') => `---
import { getCollectionPage, getCollectionStaticPaths, getDocsPage, getDocsStaticPaths } from "@cloudflare/nimbus-docs/runtime";
${getStaticPaths}
const page = await ${render};
if (page instanceof Response) return page;
---
<html><body><main>{page.entry.id}</main></body></html>
`;

const frontmatter = (body: string) => body.slice(0, body.indexOf("\n---\n") + 4);

async function outputs(root: string) {
  const read = (file: string) => readFile(path.join(root, "dist/changelog/2026-07-02-batch", file), "utf8");
  return { md: await read("index.md"), mdx: await read("index.mdx"), docs: await readFile(path.join(root, "dist/index.md"), "utf8") };
}

test("rebuilding with the caches follows markdownFields as it's added, reordered and removed", async () => {
  const first = await sites.buildSite({ "src/content.config.ts": config(), ...routes(true), ...content });
  const root = first.root;
  const before = await outputs(root);
  assert.equal(
    frontmatter(before.md),
    '---\ntitle: "Batch"\nversion: "2.4.0"\n---',
  );

  await sites.buildSite({ "src/content.config.ts": config(["date", "tags"]) }, { root });
  const added = await outputs(root);
  assert.equal(
    frontmatter(added.md),
    '---\ntitle: "Batch"\nversion: "2.4.0"\ndate: "2026-07-02"\ntags: ["api", "forecasts"]\n---',
  );
  assert.equal(frontmatter(added.mdx), frontmatter(added.md));
  assert.equal(added.docs, before.docs, "other collections are untouched");

  await sites.buildSite({ "src/content.config.ts": config(["tags", "date"]) }, { root });
  const reordered = await outputs(root);
  assert.match(reordered.md, /^---\ntitle: "Batch"\nversion: "2\.4\.0"\ntags: \["api", "forecasts"\]\ndate: "2026-07-02"\n---/);
  assert.match(reordered.mdx, /^---\ntitle: "Batch"\nversion: "2\.4\.0"\ntags: \["api", "forecasts"\]\ndate: "2026-07-02"\n---/);

  await sites.buildSite({ "src/content.config.ts": config(["tags", "date"]) }, { root });
  assert.deepEqual(await outputs(root), reordered, "an unchanged rebuild is byte-identical");

  await sites.buildSite({ "src/content.config.ts": config() }, { root });
  assert.deepEqual(await outputs(root), before, "removing the list restores the original bytes");
});

test("a request-rendered changelog serves the fields from its baked Markdown", async () => {
  const site = await sites.buildSite(
    {
      "src/content.config.ts": config(["date", "tags"]),
      ...routes(true),
      ...content,
      // The docs route serves the home page here.
      "src/pages/index.astro": null,
      "src/pages/[...slug].astro": proseRoute("export const getStaticPaths = getDocsStaticPaths;", "getDocsPage(Astro)"),
      "src/pages/changelog/[...slug].astro": proseRoute('export const getStaticPaths = getCollectionStaticPaths("changelog");'),
    },
    {
      server: true,
      packageImports: true,
      rendering: { default: "build", collections: { changelog: "request" } },
    },
  );
  const app = await siteApp(site);
  for (const [file, type] of [["index.md", "text/markdown"], ["index.mdx", "text/mdx"]] as const) {
    const response = await app.render(new Request(`https://example.test/docs/changelog/2026-07-02-batch/${file}`));
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type") ?? "", new RegExp(type));
    assert.match(
      await response.text(),
      /^---\ntitle: "Batch"\nversion: "2\.4\.0"\ndate: "2026-07-02"\ntags: \["api", "forecasts"\]\n---/,
    );
  }
});
