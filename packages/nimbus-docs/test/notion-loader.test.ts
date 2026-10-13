// The Notion source's loader, installed from the registry item into a
// project and run against a local stand-in for Notion's API through the
// client's `fetch` option, so the SDK's own pagination and retries run.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

import { fakeNotion, installNotionLoader, type FakeData, type FakeNotion } from "./fixtures/notion/fake-notion.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";

type LoaderModule = typeof import("../../nimbus-starter-source/src/loaders/notion.ts");

let project: string;
let mod: LoaderModule;
let api: FakeNotion;

const DB = "0123456789abcdef0123456789abcdef";
const page = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  blocks: [{ type: "paragraph", text: [`${title} body.`] }],
  ...extra,
});
const base = (pages = [page("p1", "One", { slug: "one", status: "Published" })]): FakeData => ({
  databaseId: DB,
  dataSources: [{ id: "ds1", name: "Docs" }],
  pages,
});

before(async () => {
  project = mkdtempSync(path.join(TEST_TMP, "nimbus-notion-loader-"));
  const file = installNotionLoader(project);
  mod = (await import(pathToFileURL(file).href)) as LoaderModule;
  api = await fakeNotion(base());
});
after(async () => {
  await api.close();
  rmSync(project, { recursive: true, force: true });
});

function context() {
  const entries = new Map<string, { id: string; data: Record<string, unknown>; body?: string }>();
  const logs: string[] = [];
  return {
    entries,
    logs,
    ctx: {
      store: {
        set: (entry: { id: string; data: Record<string, unknown>; body?: string }) => (entries.set(entry.id, entry), true),
        get: (id: string) => entries.get(id),
        has: (id: string) => entries.has(id),
        delete: (id: string) => entries.delete(id),
        keys: () => [...entries.keys()],
        values: () => [...entries.values()],
        entries: () => [...entries.entries()],
        clear: () => entries.clear(),
      },
      parseData: async ({ data }: { data: Record<string, unknown> }) => data,
      renderMarkdown: async (body: string) => ({ html: body }),
      generateDigest: (value: string) => createHash("sha256").update(value).digest("hex"),
      logger: { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`) },
      meta: new Map(),
    },
  };
}

const viaFake = (url: string | URL | Request, init?: RequestInit) =>
  fetch(String(url instanceof Request ? url.url : url).replace("https://api.notion.com", api.origin), init);

async function load(options: Record<string, unknown>, ctxState = context()) {
  await mod.notionLoader({ token: "secret_test", fetch: viaFake as typeof fetch, ...options }).load(ctxState.ctx as never);
  return ctxState;
}

test("data sources: one is used, two are listed, an explicit one skips discovery and must belong", async () => {
  api.set(base());
  const one = await load({ database: DB });
  assert.deepEqual([...one.entries.keys()], ["one"]);

  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs" }, { id: "ds2", name: "Archive" }] });
  await assert.rejects(load({ database: DB }), /database 0123456789abcdef0123456789abcdef has 2 data sources; set `dataSource` to one of: Docs \(ds1\), Archive \(ds2\)\./);
  const explicit = await load({ dataSource: "ds2" });
  assert.deepEqual([...explicit.entries.keys()], ["one"]);
  await assert.rejects(load({ database: "ffffffffffffffffffffffffffffffff", dataSource: "ds1" }), /doesn't belong to database/);
});

test("properties: named ones must exist with the right type; the publishing rule fails closed", async () => {
  api.set(base());
  await assert.rejects(load({ database: DB, properties: { slug: "URL" } }), /property "URL" \(properties\.slug\) doesn't exist\. Properties in this data source: Name \(title\), Description \(rich_text\), Slug \(rich_text\), Order \(number\), Status \(status\)\./);
  await assert.rejects(load({ database: DB, properties: { order: "Slug" } }), /property "Slug" \(properties\.order\) is rich_text; it must be number/);

  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs", properties: { Name: "title", Status: "date" } }] });
  await assert.rejects(load({ database: DB }), /property "Status" is date; the publishing property must be status, select or checkbox/);

  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs", properties: { Name: "title" } }] });
  await assert.rejects(load({ database: DB, publishedValue: "Live" }), /the publishing property "Status" doesn't exist/);
  const open = await load({ database: DB });
  assert.deepEqual([...open.entries.keys()], ["one"], "slugified title");
  assert.equal(open.entries.get("one")!.data.draft, undefined);
  assert.ok(open.logs.some((line) => /no "Status" property, so every row publishes/.test(line)));

  api.set({ ...base([page("p1", "One", { status: true })]), dataSources: [{ id: "ds1", name: "Docs", properties: { Name: "title", Status: "checkbox" } }] });
  await assert.rejects(load({ database: DB, publishedValue: "Yes" }), /is a checkbox, which has no values; remove publishedValue/);
});

test("drafts, duplicate and empty ids, and a missing token", async () => {
  api.set(base([page("p1", "One", { slug: "one", status: "Published" }), page("p2", "Two", { slug: "two", status: "Draft" })]));
  const drafts = await load({ database: DB });
  assert.equal(drafts.entries.get("two")!.data.draft, true);
  assert.match(drafts.entries.get("two")!.body!, /Two body\./, "a draft keeps its body");

  api.set(base([page("p1", "One", { slug: "same", status: "Published" }), page("p2", "Two", { slug: "same", status: "Draft" })]));
  const state = context();
  state.entries.set("kept", { id: "kept", data: {} });
  await assert.rejects(load({ database: DB }, state), /two Notion pages give the URL id "same": p1 \("One"\) and p2 \("Two"\)/);
  assert.deepEqual([...state.entries.keys()], ["kept"], "nothing written");

  api.set(base([page("p9", "", { status: "Published" })]));
  await assert.rejects(load({ database: DB }), /Notion page p9 has no Slug and its title gives no URL/);

  const saved = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    await assert.rejects(
      mod.notionLoader({ database: DB, fetch: viaFake as typeof fetch }).load(context().ctx as never),
      /NOTION_TOKEN is not set/,
    );
  } finally {
    if (saved !== undefined) process.env.NOTION_TOKEN = saved;
  }
});

test("requests: rows and blocks paginate, children nest three deep, 429 and a 503 block read retry, a 503 query fails untouched", async () => {
  const pages = ["a", "b", "c"].map((id) => page(id, id.toUpperCase(), { slug: id, status: "Published" }));
  pages[0]!.blocks = [
    { type: "paragraph", text: ["one"] },
    { type: "paragraph", text: ["two"] },
    { type: "bulleted_list_item", text: ["level 1"], children: [{ type: "bulleted_list_item", text: ["level 2"], children: [{ type: "bulleted_list_item", text: ["level 3"] }] }] },
  ];
  api.set(base(pages));
  api.requests.length = 0;
  api.fail({ method: "POST", path: /\/query$/, status: 429, headers: { "retry-after": "1" }, body: { object: "error", status: 429, code: "rate_limited", message: "slow down" } });
  api.fail({ method: "GET", path: /\/blocks\/a\/children$/, status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "busy" } });
  const loaded = await load({ database: DB });
  assert.deepEqual([...loaded.entries.keys()].sort(), ["a", "b", "c"]);
  assert.equal(api.requests.filter((r) => r.endsWith("/query")).length, 3, "429 retried, then two pages of rows");
  assert.ok(api.requests.filter((r) => r === "GET /v1/blocks/a/children").length >= 3, "503 retried, then two pages of blocks");
  assert.match(loaded.entries.get("a")!.body!, /- level 1\n  - level 2\n    - level 3/);

  const state = context();
  state.entries.set("kept", { id: "kept", data: {} });
  api.fail({ method: "POST", path: /\/query$/, status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "busy" } });
  await assert.rejects(load({ database: DB }, state), /reading Notion failed, nothing was written/);
  assert.deepEqual([...state.entries.keys()], ["kept"]);
});

test("blocks lower to Markdown; text an editor typed renders as written; unknown blocks warn once", () => {
  const warned: string[] = [];
  const tree = (block: Record<string, unknown>, children: unknown[] = []) => ({ block: { object: "block", id: "x", has_children: children.length > 0, ...block }, children });
  const rt = (text: string, extra: Record<string, unknown> = {}) => ({
    type: "text", plain_text: text, href: null, text: { content: text, link: null },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }, ...extra,
  });
  const markdown = mod.blocksToMarkdown(
    [
      tree({ type: "heading_1", heading_1: { rich_text: [rt("Intro")] } }),
      tree({ type: "paragraph", paragraph: { rich_text: [rt("Use {props} and <Tag> *here*")] } }),
      tree({ type: "callout", callout: { rich_text: [rt("Careful")] } }),
      tree({ type: "code", code: { rich_text: [rt("ls -la")], language: "shell" } }),
      tree({ type: "to_do", to_do: { rich_text: [rt("done")], checked: true } }),
      tree({ type: "toggle", toggle: { rich_text: [rt("More")] } }),
      tree({ type: "toggle", toggle: { rich_text: [rt("Again")] } }),
    ] as never,
    (type) => warned.push(type),
  );
  assert.equal(
    markdown,
    [
      "## Intro",
      "",
      "Use \\{props\\} and \\<Tag\\> \\*here\\*",
      "",
      "> **Note:** Careful",
      "",
      "```sh\nls -la\n```",
      "",
      "- [x] done",
      "",
      "More",
      "",
      "Again",
    ].join("\n"),
  );
  assert.deepEqual(warned, ["toggle", "toggle"], "the loader dedupes the warning per type");
});
