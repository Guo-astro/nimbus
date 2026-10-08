import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";

import nimbus from "../src/index.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";

const content = pathToFileURL(
  path.resolve(import.meta.dirname, "../src/content.ts"),
).href;
const endpoints = pathToFileURL(
  path.resolve(import.meta.dirname, "../src/agent-endpoints.ts"),
).href;
const runtime = pathToFileURL(
  path.resolve(import.meta.dirname, "../src/runtime.ts"),
).href;

/**
 * A site with one page collection and two plain Astro data collections:
 * `authors` (a `file()` loader) and `notes` (a plain `glob()` loader, with an
 * MDX file using a component Nimbus has never heard of). Only the helper-made
 * collection becomes pages.
 */
async function mixedSite(extraFiles: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-page-collections-"));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await write("package.json", '{"type":"module"}');
  await write(
    "nimbus.json",
    JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }),
  );
  await write(
    "src/content.config.ts",
    [
      `import { defineCollection } from "astro:content";`,
      `import { file, glob } from "astro/loaders";`,
      `import { docsCollection } from ${JSON.stringify(content)};`,
      `export const collections = {`,
      `  docs: defineCollection(docsCollection()),`,
      `  authors: defineCollection({ loader: file("src/data/authors.json") }),`,
      `  notes: defineCollection({ loader: glob({ base: "./src/content/notes", pattern: "**/*.mdx" }) }),`,
      `};`,
    ].join("\n"),
  );
  await write("src/components.ts", "export const components = {};\n");
  await write(
    "src/content/docs/guide.mdx",
    "---\ntitle: Guide\n---\n## Start\nHello pages.",
  );
  await write(
    "src/data/authors.json",
    JSON.stringify([{ id: "ada", name: "Ada Lovelace" }]),
  );
  // A data entry with a component Nimbus doesn't know. Consumed as raw
  // data only — the build must not validate or route it.
  await write(
    "src/content/notes/first.mdx",
    "---\ntitle: First note\n---\n<Widget prop=\"x\" />\n",
  );
  await write(
    "src/pages/index.astro",
    [
      "---",
      'import { getCollection } from "astro:content";',
      "const authors = await getCollection(\"authors\");",
      "const notes = await getCollection(\"notes\");",
      "---",
      "<html><head><title>Home</title></head><body>",
      "<ul>{authors.map((author) => <li>{author.data.name}</li>)}</ul>",
      "<p>notes: {notes.length}</p>",
      "</body></html>",
    ].join("\n"),
  );
  await write(
    "src/pages/[...slug].astro",
    [
      "---",
      `import { getDocsStaticPaths, getDocsPageProps } from ${JSON.stringify(runtime)};`,
      "export const prerender = true;",
      "export const getStaticPaths = getDocsStaticPaths;",
      "const { entry, Content } = await getDocsPageProps(Astro);",
      "---",
      "<html><head><title>{entry.data.title}</title></head><body><Content /></body></html>",
    ].join("\n"),
  );
  await write(
    "src/pages/llms.txt.ts",
    `import { llmsRoute } from ${JSON.stringify(endpoints)};\nexport const prerender = true;\nexport const { GET } = llmsRoute();\n`,
  );
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${JSON.stringify(endpoints)};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
  );
  for (const [file, body] of Object.entries(extraFiles)) {
    await write(file, body);
  }
  const config = {
    root: pathToFileURL(root + path.sep),
    configFile: false as const,
    logLevel: "silent" as const,
    integrations: [
      nimbus(
        { site: "https://example.test", title: "Example", search: false },
        { sitemap: false, icons: false },
      ),
    ],
  };
  return {
    root,
    config,
    read: (file: string) => readFile(path.join(root, file), "utf8"),
  };
}

test("data collections build as plain Astro data and stay out of every page surface", async () => {
  const site = await mixedSite();
  try {
    await build(site.config);
    // Criterion 2: `getCollection()` on the data collections is untouched.
    const home = await site.read("dist/index.html");
    assert.match(home, /Ada Lovelace/);
    assert.match(home, /notes: 1/);
    // Criterion 1: neither data collection becomes pages or reaches the
    // agent index; the helper-made collection does.
    const llms = await site.read("dist/llms.txt");
    assert.match(llms, /Guide/);
    assert.doesNotMatch(llms, /Ada|authors|First note|notes/);
    assert.ok(existsSync(path.join(site.root, "dist/guide/index.md")));
    assert.ok(!existsSync(path.join(site.root, "dist/notes")));
    assert.ok(!existsSync(path.join(site.root, "dist/first/index.html")));
    // The build's list records only the page collection.
    assert.deepEqual(
      JSON.parse(await site.read(".nimbus/page-collections.json")),
      {
        version: 1,
        collections: ["docs"],
        mdxFiles: ["src/content/docs/guide.mdx"],
      },
    );
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("routing a data collection through Nimbus fails the build and names the fix", async () => {
  const site = await mixedSite({
    "src/pages/notes/[...slug].astro": [
      "---",
      `import { getCollectionStaticPaths, getCollectionPageProps } from ${JSON.stringify(runtime)};`,
      "export const prerender = true;",
      'export const getStaticPaths = getCollectionStaticPaths("notes");',
      "const { entry, Content } = await getCollectionPageProps(Astro);",
      "---",
      "<html><head><title>{entry.data.title}</title></head><body><Content /></body></html>",
    ].join("\n"),
  });
  try {
    await assert.rejects(
      build(site.config),
      /"notes" is not a Nimbus page collection[\s\S]*(docsCollection|withNimbusMarkdown)/,
    );
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("MDX validation follows the registry record, not folder layout", async () => {
  // A page collection whose loader is hand-rolled with a path base, plus a
  // data collection sharing scanning-adjacent space: validation must cover
  // exactly what the helpers loaded.
  const site = await mixedSite({
    "src/content.config.ts": [
      `import { defineCollection } from "astro:content";`,
      `import { file, glob } from "astro/loaders";`,
      `import { docsCollection, withNimbusMarkdown } from ${JSON.stringify(content)};`,
      `export const collections = {`,
      `  docs: defineCollection(docsCollection()),`,
      `  authors: defineCollection({ loader: file("src/data/authors.json") }),`,
      `  notes: defineCollection({ loader: glob({ base: "./src/content/notes", pattern: "**/*.mdx" }) }),`,
      `  extra: defineCollection({ loader: withNimbusMarkdown(glob({ base: "./src/content/other", pattern: "**/*.mdx" })) }),`,
      `};`,
    ].join("\n"),
    // A page entry with an unregistered component, in a hand-rolled base
    // that no folder-reconstruction heuristic would find.
    "src/content/other/broken.mdx":
      "---\ntitle: Broken\n---\n<NotRegistered />\n",
  });
  try {
    await assert.rejects(build(site.config), /NotRegistered/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});
