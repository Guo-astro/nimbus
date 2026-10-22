// The changelog recipe, applied to the starter and built under a base path:
// pages, ids, links and the feed, from the brief's own files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const starter = join(here, "../../../packages/nimbus-starter-source");
let site = "";
let dist = "";

/** The code block under the recipe step that names `file`. */
function recipeFile(recipe: string, file: string): string {
  const heading = recipe.indexOf(`. \`${file}\``);
  assert.ok(heading > 0, `no step for ${file}`);
  return recipe.slice(heading).match(/```(?:astro|ts)\n([\s\S]*?)\n```/)![1]!;
}

const release = (id: string, date: string, extra: string, body = "Notes.\n\n## New\n\n- A change.\n") =>
  [`src/content/changelog/${id}.md`, `---\ntitle: "Release ${id}"\ndate: ${date}\n${extra}---\n\n${body}`] as const;

before(async () => {
  // Inside the starter, so its dependencies resolve; removed after.
  site = await mkdtemp(join(starter, ".changelog-recipe-"));
  dist = join(site, "dist");
  for (const part of ["src", "public", "astro.config.ts", "tsconfig.json", "nimbus.json", "package.json"])
    await cp(join(starter, part), join(site, part), { recursive: true });
  await rm(join(site, "src/content/docs"), { recursive: true });
  await mkdir(join(site, "src/content/docs"), { recursive: true });
  await writeFile(join(site, "src/content/docs/index.mdx"), "---\ntitle: Home\n---\n\nHome.\n");
  // The starter's dependencies, plus @astrojs/rss, which the recipe installs
  // and www has.
  const modules = join(starter, "node_modules");
  for (const name of await readdir(modules)) {
    if (!name.startsWith("@")) {
      await symlink(join(modules, name), join(site, "node_modules", name)).catch(async (error) => {
        if (error.code !== "ENOENT") throw error;
        await mkdir(join(site, "node_modules"), { recursive: true });
        await symlink(join(modules, name), join(site, "node_modules", name));
      });
      continue;
    }
    await mkdir(join(site, "node_modules", name), { recursive: true });
    for (const scoped of await readdir(join(modules, name)))
      await symlink(join(modules, name, scoped), join(site, "node_modules", name, scoped));
  }
  await mkdir(join(site, "node_modules/@astrojs"), { recursive: true });
  await symlink(
    dirname(createRequire(join(here, "../package.json")).resolve("@astrojs/rss/package.json")),
    join(site, "node_modules/@astrojs/rss"),
  );

  const recipe = await readFile(join(here, "features/changelog.md"), "utf8");
  for (const file of [
    "src/components/changelog/release.ts",
    "src/components/changelog/ChangelogEntry.astro",
    "src/components/changelog/ChangelogFeed.astro",
    "src/components/changelog/ChangelogPage.astro",
    "src/pages/changelog/index.astro",
    "src/pages/changelog/page/[page].astro",
    "src/pages/changelog/[...slug].astro",
    "src/pages/changelog/rss.xml.ts",
    "src/pages/og/changelog.png.ts",
  ]) {
    await mkdir(dirname(join(site, file)), { recursive: true });
    await writeFile(join(site, file), recipeFile(recipe, file));
  }
  const collection = recipe.match(/\n( {2}changelog: defineCollection\([\s\S]*?\n {2}\),)\n/)![1]!;
  const config = await readFile(join(site, "src/content.config.ts"), "utf8");
  await writeFile(join(site, "src/content.config.ts"), config.replace("export const collections = {\n", `export const collections = {\n${collection}\n`));
  const astro = await readFile(join(site, "astro.config.ts"), "utf8");
  await writeFile(join(site, "astro.config.ts"), astro.replace("export default defineConfig({\n", 'export default defineConfig({\n  base: "/docs",\n'));

  // 23 releases: versioned and not, same-day pairs, colliding anchors, a
  // nested index entry, and one with repeated and non-Latin sections. Plus a draft.
  const files = new Map<string, string>([
    release("dotted", "2026-07-04", 'version: "2.4.0"\ntags: [api]\n'),
    release("hyphened", "2026-07-03", 'version: "2-4-0"\n'),
    release("v2-4-0", "2026-07-03", ""),
    release("y2026", "2026-07-02", ""),
    release(
      "sections",
      "2026-07-01",
      "",
      "See [the fixes](#fixed).\n\n## New\n\n- One.\n\n## New\n\n- Two.\n\n## 新機能\n\n- Three.\n\n## Fixed\n\n- Four.\n",
    ),
    ["src/content/changelog/a/index.md", '---\ntitle: "Nested"\ndate: 2026-06-30\n---\n\nNested.\n'],
    release("draft", "2026-08-01", "draft: true\n"),
  ]);
  for (let i = 0; i < 17; i++) {
    const [file, body] = release(`r${String(i).padStart(2, "0")}`, `2025-${String(12 - Math.floor(i / 2)).padStart(2, "0")}-01`, `version: "1.${17 - i}.0"\n`);
    files.set(file, body);
  }
  for (const [file, body] of files) {
    await mkdir(dirname(join(site, file)), { recursive: true });
    await writeFile(join(site, file), body);
  }
  execFileSync(process.execPath, [join(starter, "node_modules/astro/bin/astro.mjs"), "build"], {
    cwd: site,
    stdio: "pipe",
  });
});

after(async () => {
  if (site) await rm(site, { recursive: true, force: true });
});

const read = (file: string) => readFile(join(dist, file), "utf8");
const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
const article = (html: string) => html.slice(html.indexOf("<article"), html.indexOf("</article>"));

test("three list pages of 10, 10 and 3; page 1 is /changelog/, nothing past the last", async () => {
  for (const file of ["changelog/index.html", "changelog/page/2/index.html", "changelog/page/3/index.html"])
    assert.ok(existsSync(join(dist, file)), file);
  for (const file of ["changelog/page/1/index.html", "changelog/page/4/index.html", "changelog/draft/index.html"])
    assert.ok(!existsSync(join(dist, file)), file);
  const counts = await Promise.all(
    ["changelog/index.html", "changelog/page/2/index.html", "changelog/page/3/index.html"].map(
      async (file) => (await read(file)).match(/class="cl-release"/g)?.length,
    ),
  );
  assert.deepEqual(counts, [10, 10, 3]);
});

test("list pages: unique ids, sections below h3 without ids, links to sections go to the release page", async () => {
  const html = await read("changelog/index.html");
  const all = ids(html);
  assert.equal(new Set(all).size, all.length, `duplicate ids: ${all}`);
  for (const id of ["y2026", "v2-4-0", "v2-4-0-2", "v2-4-0-3", "y2026-2"]) assert.ok(all.includes(id), id);
  for (const section of article(html).split('class="cl-release"').slice(1).map((part) => part.slice(0, part.indexOf("</section>")))) {
    assert.doesNotMatch(section, /<h[12][\s>]/);
    assert.doesNotMatch(section, /<h[4-6][^>]*\sid=/);
  }
  assert.match(html, /href="\/docs\/changelog\/sections\/#fixed"/);
  assert.match(html, /href="\/docs\/changelog\/a\/"/);
  assert.match(html, /href="\/docs\/changelog\/page\/2\/"/);
});

test("a release page lists its sections, repeated and non-Latin, and every link resolves", async () => {
  const html = await read("changelog/sections/index.html");
  const pageIds = new Set(ids(html));
  const toc = [...html.matchAll(/data-nb-toc-link[^>]*data-nb-slug="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(toc.length, 4);
  assert.equal(new Set(toc).size, 4);
  for (const slug of toc) assert.ok(pageIds.has(slug), slug);
  assert.match(html, /href="#fixed"/);
  assert.ok(pageIds.has("fixed"));
  assert.match(html, /href="\/docs\/changelog\/"/);
  assert.ok(existsSync(join(dist, "changelog/a/index.html")));
});

test("feed and Markdown: every release, base-prefixed links, date and tags in the frontmatter", async () => {
  const rss = await read("changelog/rss.xml");
  assert.equal(rss.match(/<item>/g)?.length, 23);
  assert.match(rss, /<link>https:\/\/example\.com\/docs\/changelog\/<\/link>/);
  assert.match(rss, /<guid isPermaLink="true">https:\/\/example\.com\/docs\/changelog\/a\/<\/guid>/);
  assert.match(rss, /<atom:link href="https:\/\/example\.com\/docs\/changelog\/rss\.xml"/);
  assert.doesNotMatch(rss, /draft/);
  const md = await read("changelog/dotted/index.md");
  assert.match(md, /^---\ntitle: "Release dotted"\nversion: "2\.4\.0"\ndate: "2026-07-04"\ntags: \["api"\]\n---/);
});
