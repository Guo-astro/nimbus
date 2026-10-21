// A site whose content.config.ts declares no `docs` collection builds its
// sidebar without asking Astro for one, unless its sidebar names `docs`. A
// hand-written `docs`, or a config Nimbus can't read, is queried as before.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";

import { agentSites } from "./fixtures/agent-site.ts";

const sites = agentSites();
after(() => sites.cleanup());

const runtime = JSON.stringify("@cloudflare/nimbus-docs/runtime");

const glob = (collection: string) =>
  `defineCollection({ loader: glob({ pattern: "**/*.md", base: "./src/content/${collection}" }), schema: z.object({ title: z.string() }) })`;

const config = (collections: string) => `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
${collections}`;

const FILES: Record<string, string> = {
  "src/content/guides/start.md": "---\ntitle: Start\n---\nStart.\n",
  "src/content/docs/intro.md": "---\ntitle: Intro\n---\nIntro.\n",
  "src/pages/index.astro": `---
import { getSidebar } from ${runtime};
export const prerender = true;
const labels = [];
const walk = (items) => {
  for (const item of items) {
    labels.push(item.label);
    if (item.type === "group") walk(item.children);
  }
};
walk(await getSidebar("/"));
---
<html><body><main data-labels={JSON.stringify(labels)}>page</main></body></html>
`,
};

async function build(contentConfig: string, sidebar: unknown) {
  const site = await sites.buildSite(
    { ...FILES, "src/content.config.ts": contentConfig },
    { packageImports: true, logLevel: "warn", base: "/", sidebar },
  );
  const html = await readFile(path.join(site.root, "dist/index.html"), "utf8");
  return { logs: site.logs, labels: JSON.parse(/data-labels="([^"]*)"/.exec(html)![1]!.replaceAll("&quot;", '"')) as string[] };
}

const GUIDES = { items: [{ label: "Guides", autogenerate: { collection: "guides" } }] };

test("a site without docs lists a hand-written collection its sidebar names, without querying docs", async () => {
  const { logs, labels } = await build(config(`export const collections = { guides: ${glob("guides")} };`), GUIDES);
  assert.ok(labels.includes("Start"), labels.join(", "));
  assert.doesNotMatch(logs, /collection "docs"/);
});

for (const [shape, collections] of [
  ["declared", `export const collections = { docs: ${glob("docs")} };`],
  ["added through an alias", `export const collections = {};\nconst registered = collections;\nregistered.docs = ${glob("docs")};`],
] as const) {
  test(`a hand-written docs collection ${shape} is still queried`, async () => {
    const { labels } = await build(config(collections), undefined);
    assert.ok(labels.includes("Intro"), labels.join(", "));
  });
}

for (const [reads, item] of [
  ["by collection", { label: "Docs", autogenerate: { collection: "docs" } }],
  ["by directory", { label: "Docs", autogenerate: { directory: "intro" } }],
  ["by page slug", "intro"],
] as const) {
  test(`a sidebar that reads docs ${reads} on a site without it keeps Astro's warning`, async () => {
    const { logs } = await build(
      config(`export const collections = { guides: ${glob("guides")} };`),
      { items: [...GUIDES.items, item] },
    );
    assert.match(logs, /collection "docs"/);
  });
}

for (const [shape, collections] of [
  ["a spread", `const shared = { guides: ${glob("guides")} };\nexport const collections = { ...shared };`],
  ["an unknown shape", `const make = () => ({ guides: ${glob("guides")} });\nexport const collections = make();`],
] as const) {
  test(`a config with ${shape} is queried for docs as before`, async () => {
    const { logs, labels } = await build(config(collections), GUIDES);
    assert.ok(labels.includes("Start"), labels.join(", "));
    assert.match(logs, /collection "docs"/);
  });
}
