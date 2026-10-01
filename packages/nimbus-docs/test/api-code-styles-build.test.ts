// `astro build` gate for API code colours. Static API pages highlight their
// samples while rendering, inside the bundle Astro builds from this package,
// and the integration writes `_nimbus/shiki.css` afterwards. Every token class
// a page uses must be defined there, or that code renders uncoloured.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })));
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);
const SPEC = path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml");

// Renders every sample and example the way the starter's code rail does.
const PAGE = `---
import { getApiRoute, getApiStaticPaths } from ${moduleUrl("../src/runtime.ts")};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
const { page } = result;
const code = page.kind === "operation"
  ? [...page.samples, ...page.responses.flatMap((r) => (r.example ? [r.example] : []))]
  : [];
---
<main>{code.map((c) => <Fragment set:html={c.highlightedHtml ?? ""} />)}</main>`;

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("static API pages' code token classes are all defined in shiki.css", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-api-code-styles-"));
  roots.push(root);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(apiCollection()),
};`,
  );
  // No code blocks in docs content, so only API pages can register token styles.
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
  await write("src/pages/api/[...slug].astro", PAGE);
  await write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${moduleUrl("../src/runtime.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<p>doc</p>`,
  );

  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    vite: { cacheDir: path.join(root, ".vite") },
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          search: false,
          api: [{ collection: "api", spec: SPEC }],
        },
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  });

  const dist = path.join(root, "dist");
  const used = new Set<string>();
  for (const file of await htmlFiles(path.join(dist, "api"))) {
    for (const [name] of (await readFile(file, "utf8")).matchAll(/nb-shiki-[a-z0-9]+/g)) used.add(name);
  }
  const css = await readFile(path.join(dist, "_nimbus/shiki.css"), "utf8");
  const defined = new Set([...css.matchAll(/\.(nb-shiki-[a-z0-9]+)\{/g)].map((m) => m[1]!));
  assert.ok(used.size > 0, "API pages render classed code tokens");
  assert.deepEqual([...used].filter((name) => !defined.has(name)), [], "every token class is defined");
});
