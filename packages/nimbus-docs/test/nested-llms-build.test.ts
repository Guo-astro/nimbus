// Nested llms.txt sections, end to end: the `[...section]` route serves an
// index per folder, every "Sections" link resolves, the old `[section]` route
// keeps today's flat indexes, and both at once fail the build.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";

import { agentManifest, agentSites, siteApp, srcModule } from "./fixtures/agent-site.ts";

const sites = agentSites();
afterEach(() => sites.cleanup());

const endpoints = srcModule("agent-endpoints.ts");

const CONTENT = {
  "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  changelog: defineCollection(docsCollection({ base: "changelog" })),
};`,
  "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
  "src/content/docs/reference/index.mdx": "---\ntitle: Reference\n---\nRef.\n",
  "src/content/docs/reference/overview.mdx": "---\ntitle: Overview\n---\nOverview.\n",
  "src/content/docs/reference/functions/math.mdx": "---\ntitle: Math\n---\nMath.\n",
  "src/content/docs/reference/functions/dates/parse.mdx": "---\ntitle: Parse\n---\nParse.\n",
  "src/content/changelog/first.mdx": "---\ntitle: First\n---\nFirst.\n",
  "src/content/changelog/2024/launch.mdx": "---\ntitle: Launch\n---\nLaunch.\n",
};

function sectionRoute(folder: string, prerender: boolean): Record<string, string> {
  return {
    "src/pages/llms.txt.ts": `import { llmsRoute } from ${endpoints};
export const prerender = ${prerender};
export const { GET } = llmsRoute();
`,
    [`src/pages/${folder}/llms.txt.ts`]: `import { llmsSectionRoute } from ${endpoints};
export const prerender = ${prerender};
export const { GET, getStaticPaths } = llmsSectionRoute();
`,
  };
}

/** `/docs/a/llms.txt` → `a/llms.txt`, for every "Sections" link in a body. */
function sectionLinks(body: string): string[] {
  return [...body.matchAll(/\(https:\/\/example\.test\/docs\/([^)]+\/llms\.txt)\)/gu)].map(([, url]) => url!);
}

test("[...section] writes an index per folder and every Sections link resolves", async () => {
  const site = await sites.buildSite({ ...CONTENT, ...sectionRoute("[...section]", true) });
  const sections = (await agentManifest(site.root)).llmsAssets
    .filter((asset) => asset.scope === "section")
    .map((asset) => asset.section)
    .sort();
  assert.deepEqual(sections, [
    "changelog",
    "changelog/2024",
    "reference",
    "reference/functions",
    "reference/functions/dates",
  ]);
  const seen = new Set<string>();
  const queue = sectionLinks(await readFile(path.join(site.root, "dist/llms.txt"), "utf8"));
  while (queue.length > 0) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const file = path.join(site.root, "dist", url);
    assert.ok(existsSync(file), `${url} is linked but not written`);
    queue.push(...sectionLinks(await readFile(file, "utf8")));
  }
  assert.deepEqual([...seen].sort(), sections.map((section) => `${section}/llms.txt`).sort());
  assert.match(
    await readFile(path.join(site.root, "dist/reference/llms.txt"), "utf8"),
    /## Sections\n\n- \[Functions\]\(https:\/\/example\.test\/docs\/reference\/functions\/llms\.txt\)/,
  );
});

test("the old [section] route keeps one flat index per top-level section", async () => {
  const site = await sites.buildSite({ ...CONTENT, ...sectionRoute("[section]", true) });
  assert.ok(!existsSync(path.join(site.root, "dist/reference/functions/llms.txt")));
  const reference = await readFile(path.join(site.root, "dist/reference/llms.txt"), "utf8");
  assert.doesNotMatch(reference, /## Sections/);
  assert.match(reference, /\[Parse\]/);
});

test("[...section] rendered on request serves nested sections and 404s unknown ones", async () => {
  const site = await sites.buildSite(
    { ...CONTENT, ...sectionRoute("[...section]", false) },
    { server: true },
  );
  const app = await siteApp(site);
  for (const url of ["reference/llms.txt", "reference/functions/llms.txt", "reference/functions/dates/llms.txt", "changelog/2024/llms.txt"]) {
    const response = await app.render(new Request(`https://example.test/docs/${url}`));
    assert.equal(response.status, 200, url);
    for (const link of sectionLinks(await response.text())) {
      assert.equal((await app.render(new Request(`https://example.test/docs/${link}`))).status, 200, link);
    }
  }
  const llms = await app.render(new Request("https://example.test/docs/llms.txt"));
  assert.match(await llms.text(), /^# Test/);
  assert.equal((await app.render(new Request("https://example.test/docs/reference/nope/llms.txt"))).status, 404);
});

test("both section routes at once fail the build, naming both", async () => {
  await assert.rejects(
    sites.buildSite({
      ...CONTENT,
      ...sectionRoute("[section]", true),
      ...sectionRoute("[...section]", true),
    }),
    /\[section\]\/llms\.txt\.ts and src\/pages\/\[\.\.\.section\]\/llms\.txt\.ts|\[\.\.\.section\]\/llms\.txt\.ts and src\/pages\/\[section\]\/llms\.txt\.ts/,
  );
});

for (const folder of ["[...section]", "[section]"] as const) {
  test(`a request-rendered mount beside a prebuilt root, ${folder} route: every linked index is served`, async () => {
    const site = await sites.buildSite(
      {
        ...CONTENT,
        ...sectionRoute(folder, true),
        "src/pages/[...slug].astro": `---\nimport { getDocsStaticPaths, getDocsPageProps } from ${srcModule("index.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\nawait getDocsPageProps(Astro);\n---\n<html><body>Page</body></html>`,
        "src/pages/changelog/[...slug].astro": `---\nimport { getCollectionPage } from ${srcModule("index.ts")};\nconst page = await getCollectionPage(Astro);\nif (page instanceof Response) return page;\n---\n<html><body>Entry</body></html>`,
      },
      { server: true, rendering: { default: "build", collections: { changelog: "request" } } },
    );
    const app = await siteApp(site);
    const nested = folder === "[...section]";
    // The root's sections are prebuilt; the mount's render on request.
    assert.equal(existsSync(path.join(site.root, "dist/reference/functions/llms.txt")), nested);
    assert.ok(!existsSync(path.join(site.root, "dist/changelog/llms.txt")));
    const changelog = await app.render(new Request("https://example.test/docs/changelog/llms.txt"));
    assert.equal(changelog.status, 200);
    const body = await changelog.text();
    assert.equal(/## Sections/.test(body), nested);
    for (const link of sectionLinks(body)) {
      const response = await app.render(new Request(`https://example.test/docs/${link}`));
      assert.equal(response.status, 200, link);
      assert.match(await response.text(), /Launch/);
    }
    assert.equal(
      (await app.render(new Request("https://example.test/docs/changelog/2024/llms.txt"))).status,
      nested ? 200 : 404,
    );
  });
}
