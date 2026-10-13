// The Notion source in a real build: the Markdown parity row (a Notion page
// renders, twins and indexes like a local one), drafts in dev and production,
// and a second sync that edits, renames, deletes and unpublishes. Drafts in
// dev are in notion-dev.test.ts: a dev server and a build in one process
// share module state.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "astro";
import { JSDOM } from "jsdom";

import { fakeNotion, installNotionLoader, type FakeNotion, type FakePage } from "./fixtures/notion/fake-notion.ts";
import { pageRoute, paritySite, type ParitySite } from "./fixtures/parity-site.ts";

const DB = "0123456789abcdef0123456789abcdef";
let api: FakeNotion;

before(async () => {
  api = await fakeNotion({ databaseId: DB, dataSources: [{ id: "ds1", name: "Docs" }], pages: [] });
  process.env.NOTION_TEST_ORIGIN = api.origin;
  process.env.NOTION_TOKEN = "secret_test";
});
after(async () => {
  await api.close();
  delete process.env.NOTION_TEST_ORIGIN;
  delete process.env.NOTION_TOKEN;
});

const BODY_MD = (title: string) =>
  [
    `## ${title} overview`,
    "",
    "Some text with a [link to setup](/setup/) and a [create call](api.ref:api:create).",
    "",
    "- one",
    "- two",
    "",
    "| Key | Value |",
    "| --- | --- |",
    "| a | 1 |",
    "",
    "```javascript",
    "console.log(1);",
    "```",
    "",
    "![Logo](https://example.test/logo.png)",
    "",
  ].join("\n");

const blocks = (title: string): FakePage["blocks"] => [
  { type: "heading_1", text: [`${title} overview`] },
  { type: "paragraph", text: ["Some text with a ", { text: "link to setup", href: "/setup/" }, " and a ", { text: "create call", href: "api.ref:api:create" }, "."] },
  { type: "bulleted_list_item", text: ["one"] },
  { type: "bulleted_list_item", text: ["two"] },
  { type: "table", rows: [["Key", "Value"], ["a", "1"]] },
  { type: "code", text: ["console.log(1);"], language: "javascript" },
  { type: "image", url: "https://example.test/logo.png", text: ["Logo"] },
];

async function notionSite(): Promise<ParitySite> {
  const site = await paritySite({
    contentImports: [`import { notionLoader } from "./loaders/notion";`],
    extraCollections: [
      `notion: defineCollection({ loader: withNimbusMarkdown(notionLoader({ database: ${JSON.stringify(DB)}, fetch: (url, init) => fetch(String(url).replace("https://api.notion.com", process.env.NOTION_TEST_ORIGIN), init) })), schema: docsCollection().schema })`,
    ],
    routes: { "src/pages/notion/[...slug].astro": pageRoute("notion") },
  });
  installNotionLoader(site.root);
  return site;
}

const main = (html: string) => new JSDOM(html).window.document.querySelector("main")!.innerHTML;

test("a Notion page renders, twins and indexes like a local Markdown page", async () => {
  const site = await notionSite();
  try {
    await site.write("src/content/docs/guide-file.md", `---\ntitle: Guide\nslug: guide\n---\n\n${BODY_MD("Guide")}`);
    await site.write("src/content/docs/setup.md", `---\ntitle: Setup\n---\n\n${BODY_MD("Setup")}`);
    api.set({
      databaseId: DB,
      dataSources: [{ id: "ds1", name: "Docs" }],
      pages: [
        { id: "p-guide", title: "Guide", slug: "guide", status: "Published", blocks: blocks("Guide") },
        { id: "p-setup", title: "Setup", status: "Published", blocks: blocks("Setup") },
      ],
    });
    await build(site.config);
    for (const id of ["guide", "setup"]) {
      assert.equal(main(await site.read(`dist/notion/${id}/index.html`)), main(await site.read(`dist/${id}/index.html`)), id);
      const twin = (await site.read(`dist/notion/${id}/index.md`)).replace("docs.example.test/notion/", "docs.example.test/");
      assert.equal(twin, await site.read(`dist/${id}/index.md`), `${id} twin`);
    }
    assert.match(await site.read("dist/notion/llms.txt"), /notion\/setup\/index\.md/);
  } finally {
    await site.remove();
  }
});

test("a second sync edits, renames, deletes and unpublishes; a draft leaves the production build", async () => {
  const site = await notionSite();
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    const p = (id: string, title: string, extra: Partial<FakePage> = {}): FakePage => ({
      id,
      title,
      status: "Published",
      blocks: [{ type: "paragraph", text: [`${title} first.`] }],
      ...extra,
    });
    api.set({ databaseId: DB, dataSources: [{ id: "ds1", name: "Docs" }], pages: [p("p1", "Edited"), p("p2", "Old Name", { slug: "old-name" }), p("p3", "Deleted"), p("p4", "Drafted")] });
    await build(site.config);
    for (const id of ["edited", "old-name", "deleted", "drafted"]) assert.ok(existsSync(`${site.root}/dist/notion/${id}/index.html`), id);

    api.set({
      databaseId: DB,
      dataSources: [{ id: "ds1", name: "Docs" }],
      pages: [
        p("p1", "Edited", { blocks: [{ type: "paragraph", text: ["Edited second."] }] }),
        p("p2", "Old Name", { slug: "new-name" }),
        p("p4", "Drafted", { status: "Draft" }),
      ],
    });
    await build(site.config);
    assert.match(await site.read("dist/notion/edited/index.html"), /Edited second\./);
    assert.ok(existsSync(`${site.root}/dist/notion/new-name/index.html`));
    for (const gone of ["old-name", "deleted", "drafted"]) {
      assert.ok(!existsSync(`${site.root}/dist/notion/${gone}/index.html`), `${gone} page`);
      assert.ok(!existsSync(`${site.root}/dist/notion/${gone}/index.md`), `${gone} twin`);
    }
    const llms = await site.read("dist/notion/llms.txt");
    assert.doesNotMatch(llms, /old-name|deleted|drafted/);
    assert.match(llms, /new-name/);

  } finally {
    await site.remove();
  }
});

test("a draft whose slug clashes with a published row fails before anything is written", async () => {
  const site = await notionSite();
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    api.set({
      databaseId: DB,
      dataSources: [{ id: "ds1", name: "Docs" }],
      pages: [
        { id: "p1", title: "Live", slug: "same", status: "Published", blocks: [] },
        { id: "p2", title: "Draft", slug: "same", status: "Draft", blocks: [] },
      ],
    });
    await assert.rejects(build(site.config), /two Notion pages give the URL id "same": p1 \("Live"\) and p2 \("Draft"\)/);
    // The failed sync's store write settles after the rejection.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } finally {
    await site.remove();
  }
});
