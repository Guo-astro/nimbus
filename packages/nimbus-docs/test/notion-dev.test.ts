// A Notion draft in `astro dev`: a page with its body. Its own file, because a
// dev server and a build in one process share module state.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { dev } from "astro";
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

test("a draft is a page in dev, with its body", async () => {
  const site = await notionSite();
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    api.set({
      databaseId: DB,
      dataSources: [{ id: "ds1", name: "Docs" }],
      pages: [{ id: "p4", title: "Drafted", status: "Draft", blocks: [{ type: "paragraph", text: ["Drafted first."] }] }],
    });
    const server = await dev({ ...site.config, server: { port: 0, host: "127.0.0.1" } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address.port}/notion/drafted/`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Drafted first\./);
    } finally {
      await server.stop();
    }
  } finally {
    await site.remove();
  }
});

