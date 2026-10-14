// The page-collection contract for Markdown: a page renders the same whether
// its file is under `src/content`, in a folder outside `src/`, or has no file
// at all, and every pass that treats it as a page finds it.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { build } from "astro";
import { JSDOM } from "jsdom";

import { paritySite, type MemoryPage, type ParitySite } from "./fixtures/parity-site.ts";

const body = (name: string) =>
  [
    `## ${name} overview`,
    "",
    "Some text with a [link to setup](/setup/) and a [create call](api.ref:api:create).",
    "",
    "- one",
    "- two",
    "",
    "| Key | Value |",
    "|---|---|",
    "| a | 1 |",
    "",
    "```js",
    "console.log(1);",
    "```",
    "",
    "### Details",
    "",
    "![Logo](https://example.test/logo.png)",
    "",
  ].join("\n");

/** Two pages per row: `guide` (by slug override) and `setup`. */
const PAGES = [
  { file: "guide-file.md", id: "guide", title: "Guide", slug: "guide" },
  { file: "setup.md", id: "setup", title: "Setup" },
];

const frontmatter = (page: (typeof PAGES)[number]) =>
  `---\ntitle: ${page.title}\n${page.slug ? `slug: ${page.slug}\n` : ""}---\n\n`;

async function writeRows(site: ParitySite) {
  for (const page of PAGES) {
    await site.write(`src/content/docs/${page.file}`, frontmatter(page) + body(page.title));
    await site.write(`external/ext/${page.file}`, frontmatter(page) + body(page.title));
  }
}

const MEMORY: MemoryPage[] = PAGES.map((page) => ({ id: page.id, title: page.title, body: body(page.title) }));

function main(html: string): string {
  return new JSDOM(html).window.document.querySelector("main")!.innerHTML;
}

test("Markdown pages render, twin and index the same from a local glob, an external glob and an in-memory loader", async () => {
  const site = await paritySite({ memory: MEMORY });
  try {
    await writeRows(site);
    await build(site.config);
    const rows = [
      { prefix: "", dir: "dist" },
      { prefix: "/ext", dir: "dist/ext" },
      { prefix: "/mem", dir: "dist/mem" },
    ];
    for (const id of ["guide", "setup"]) {
      const htmls = await Promise.all(rows.map((row) => site.read(`${row.dir}/${id}/index.html`)));
      const bodies = htmls.map(main);
      assert.equal(bodies[1], bodies[0], `ext/${id} HTML differs from docs`);
      assert.equal(bodies[2], bodies[0], `mem/${id} HTML differs from docs`);
      // The citation resolved to the API page in every row.
      assert.doesNotMatch(bodies[0]!, /api\.ref:/);
      assert.match(bodies[0]!, /href="\/api\//);
      const twins = await Promise.all(
        rows.map(async (row) =>
          (await site.read(`${row.dir}/${id}/index.md`)).replace(`docs.example.test${row.prefix}/`, "docs.example.test/"),
        ),
      );
      assert.equal(twins[1], twins[0], `ext/${id} twin differs`);
      assert.equal(twins[2], twins[0], `mem/${id} twin differs`);
      assert.doesNotMatch(twins[0]!, /api\.ref:/);
    }
    // The root index lists the docs pages and links each other collection's
    // section index, which lists its pages.
    const root = await site.read("dist/llms.txt");
    assert.match(root, /https:\/\/docs\.example\.test\/guide\/index\.md/);
    for (const section of ["ext", "mem"]) {
      assert.match(root, new RegExp(`https://docs\\.example\\.test/${section}/llms\\.txt`));
      const text = await site.read(`dist/${section}/llms.txt`);
      for (const id of ["guide", "setup"]) {
        assert.match(text, new RegExp(`https://docs\\.example\\.test/${section}/${id}/index\\.md`), `${section}/${id} missing`);
      }
    }
  } finally {
    await site.remove();
  }
});

const DUPLICATE = /Duplicate route is claimed by more than one source \(nimbus\/duplicate-slug\)/;
const page = (title: string, slug?: string) => `---\ntitle: ${title}\n${slug ? `slug: ${slug}\n` : ""}---\n\n${title} body.\n`;

/** Build clean (no content cache), then again on the cache of a good build. */
async function assertFailsCleanAndCached(
  site: ParitySite,
  good: () => Promise<void>,
  bad: () => Promise<void>,
  sources: RegExp[],
) {
  await good();
  await bad();
  for (const label of ["clean", "cached"] as const) {
    if (label === "clean") await rm(path.join(site.root, ".astro"), { recursive: true, force: true });
    else {
      await rm(path.join(site.root, ".astro"), { recursive: true, force: true });
      await good();
      await build(site.config);
      await bad();
    }
    await assert.rejects(build(site.config), (error: Error) => {
      assert.match(error.message, DUPLICATE, `${label}: ${error.message}`);
      for (const source of sources) assert.match(error.message, source, `${label}: ${error.message}`);
      return true;
    });
  }
}

test("two files with one slug fail the build in a Nimbus glob and a hand-written glob, clean and cached", async () => {
  const site = await paritySite();
  try {
    await site.write("src/content/docs/index.md", page("Home"));
    await assertFailsCleanAndCached(
      site,
      async () => {
        await rm(path.join(site.root, "src/content/docs/b.md"), { force: true });
        await rm(path.join(site.root, "external/ext/two.md"), { force: true });
        await site.write("src/content/docs/a.md", page("A", "shared"));
        await site.write("external/ext/one.md", page("One", "same"));
      },
      async () => {
        await site.write("src/content/docs/b.md", page("B", "shared"));
      },
      [/src\/content\/docs\/a\.md/, /src\/content\/docs\/b\.md/],
    );
    await assertFailsCleanAndCached(
      site,
      async () => {
        await rm(path.join(site.root, "src/content/docs/b.md"), { force: true });
        await rm(path.join(site.root, "external/ext/two.md"), { force: true });
      },
      async () => {
        await site.write("external/ext/two.md", page("Two", "same"));
      },
      [/external\/ext\/one\.md/, /external\/ext\/two\.md/],
    );
  } finally {
    await site.remove();
  }
});

test("a byte-identical copy at foo/index.mdx fails in a Nimbus collection, clean and cached", async () => {
  const site = await paritySite();
  try {
    const copy = page("Foo");
    await site.write("src/content/docs/index.md", page("Home"));
    await assertFailsCleanAndCached(
      site,
      async () => {
        await rm(path.join(site.root, "src/content/docs/foo"), { recursive: true, force: true });
        await site.write("src/content/docs/foo.mdx", copy);
      },
      async () => {
        await site.write("src/content/docs/foo/index.mdx", copy);
      },
      [/src\/content\/docs\/foo\.mdx/, /src\/content\/docs\/foo\/index\.mdx/],
    );
  } finally {
    await site.remove();
  }
});

test("two in-memory ids on one URL fail the build", async () => {
  const site = await paritySite({
    memory: [
      { id: "a", title: "A", body: "A." },
      { id: "a/index", title: "A index", body: "A index." },
    ],
  });
  try {
    await site.write("src/content/docs/index.md", page("Home"));
    await assert.rejects(build(site.config), (error: Error) => {
      assert.match(error.message, DUPLICATE);
      assert.match(error.message, /\/mem\/a\s+←\s+mem:a, mem:a\/index/);
      return true;
    });
  } finally {
    await site.remove();
  }
});

test("a slug that moves to a new file passes in a hand-written glob on a cached build, 20 times", async () => {
  const site = await paritySite();
  try {
    await site.write("src/content/docs/index.md", page("Home"));
    for (let run = 0; run < 20; run++) {
      // A holds `foo`; then A moves to `bar` and a new file B takes `foo`.
      await rm(path.join(site.root, "external/ext/b.md"), { force: true });
      await site.write("external/ext/a.md", page(`A ${run}`, "foo"));
      await build(site.config);
      await site.write("external/ext/a.md", page(`A ${run}`, "bar"));
      await site.write("external/ext/b.md", page(`B ${run}`, "foo"));
      await build(site.config);
      assert.ok(existsSync(path.join(site.root, "dist/ext/bar/index.html")), `run ${run}: bar missing`);
      assert.match(await site.read("dist/ext/foo/index.html"), new RegExp(`B ${run}`), `run ${run}`);
    }
  } finally {
    await site.remove();
  }
});
