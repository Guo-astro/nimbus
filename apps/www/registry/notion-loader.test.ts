// The loader the Notion guide writes, taken from the guide's code block and
// run against a local stand-in for Notion's API through the client's `fetch`
// option, so @notionhq/client's pagination and retries and notion-to-md's
// block conversion run for real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markdownToHtml } from "satteri";

import { fakeNotion, type FakeBlock, type FakeData, type FakeNotion } from "./fixtures/fake-notion.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDE = readFileSync(resolve(HERE, "sources/notion.md"), "utf8");
const CODE = GUIDE.match(/Write `src\/loaders\/notion\.ts`:\n\n```ts\n([\s\S]*?)\n```\n/)?.[1];
if (!CODE) throw new Error("sources/notion.md: no ```ts block after \"Write `src/loaders/notion.ts`:\"; update this test's pattern.");

type LoaderModule = { notionLoader: (options: Record<string, unknown>) => { load: (ctx: never) => Promise<void> } };

let dir: string;
let file: string;
let mod: LoaderModule;
let api: FakeNotion;

const DB = "0123456789abcdef0123456789abcdef";
const page = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  blocks: [{ type: "paragraph", text: [`${title} body.`] }] as FakeBlock[],
  ...extra,
});
const base = (pages = [page("p1", "One", { slug: "one", status: "Published" })]): FakeData => ({
  databaseId: DB,
  dataSources: [{ id: "ds1", name: "Docs" }],
  pages,
});

before(async () => {
  // Under node_modules so the file resolves the packages the way a project's does.
  const scratch = resolve(HERE, "../node_modules/.cache");
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(join(scratch, "notion-loader-"));
  file = join(dir, "notion.ts");
  writeFileSync(file, CODE);
  mod = (await import(pathToFileURL(file).href)) as LoaderModule;
  api = await fakeNotion(base());
});
after(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the guide's loader typechecks under Astro's strict tsconfig, against the packages it installs", () => {
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ extends: "astro/tsconfigs/strict", compilerOptions: { types: ["node"], skipLibCheck: true }, files: ["notion.ts"] }),
  );
  try {
    execFileSync(resolve(HERE, "../node_modules/.bin/tsc"), ["--noEmit", "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
  } catch (error) {
    assert.fail(`tsc: ${(error as { stdout?: string }).stdout ?? error}`);
  }
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
        delete: (id: string) => entries.delete(id),
        keys: () => [...entries.keys()],
      },
      parseData: async ({ data }: { data: Record<string, unknown> }) => data,
      renderMarkdown: async (body: string) => ({ html: body }),
      generateDigest: (value: string) => createHash("sha256").update(value).digest("hex"),
      logger: { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`) },
    },
  };
}

const viaFake = (url: string | URL | Request, init?: RequestInit) =>
  fetch(String(url instanceof Request ? url.url : url).replace("https://api.notion.com", api.origin), init);

async function load(options: Record<string, unknown>, state = context()) {
  await mod.notionLoader({ token: "secret_test", fetch: viaFake, ...options }).load(state.ctx as never);
  return state;
}

test("data sources: one is used, two are listed, an explicit one skips discovery and must belong", async () => {
  api.set(base());
  assert.deepEqual([...(await load({ database: DB })).entries.keys()], ["one"]);

  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs" }, { id: "ds2", name: "Archive" }] });
  await assert.rejects(load({ database: DB }), /has 2 data sources; set `dataSource` to one of: Docs \(ds1\), Archive \(ds2\)\./);
  assert.deepEqual([...(await load({ dataSource: "ds2" })).entries.keys()], ["one"]);
  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs" }, { id: "ds2", name: "Archive", in_trash: true }] });
  assert.deepEqual([...(await load({ database: DB })).entries.keys()], ["one"], "a trashed data source doesn't count");
  await assert.rejects(load({ database: "ffffffffffffffffffffffffffffffff", dataSource: "ds1" }), /doesn't belong to database/);
});

test("properties: named ones must exist with the right type; the publishing rule fails closed", async () => {
  api.set(base());
  await assert.rejects(
    load({ database: DB, properties: { slug: "URL" } }),
    /property "URL" \(properties\.slug\) doesn't exist\. Properties: Name \(title\), Description \(rich_text\), Slug \(rich_text\), Order \(number\), Status \(status\)\./,
  );
  await assert.rejects(load({ database: DB, properties: { order: "Slug" } }), /property "Slug" is rich_text; it must be number\. Change its type, or point properties\.order at another property\./);
  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs", properties: { Name: "title", Slug: "url" } }] });
  await assert.rejects(load({ database: DB }), /property "Slug" is url; it must be rich_text/, "a default name is checked too");

  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs", properties: { Name: "title", Status: "date" } }] });
  await assert.rejects(load({ database: DB }), /property "Status" is date; the publishing property must be status, select or checkbox/);

  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs", properties: { Name: "title", State: "status" } }] });
  await assert.rejects(load({ database: DB }), /there's no "Status" property, but "State" is a status property\. Set properties\.status: "State"/, "a renamed status never publishes drafts");

  api.set({ ...base(), dataSources: [{ id: "ds1", name: "Docs", properties: { Name: "title" } }] });
  await assert.rejects(load({ database: DB, publishedValue: "Live" }), /the publishing property "Status" doesn't exist/);
  const open = await load({ database: DB });
  assert.deepEqual([...open.entries.keys()], ["one"], "slugified title");
  assert.equal(open.entries.get("one")!.data.draft, undefined);
  assert.ok(open.logs.some((line) => /no "Status" property, so every row publishes/.test(line)));

  api.set({ ...base([page("p1", "One", { status: true }), page("p2", "Two", { status: false })]), dataSources: [{ id: "ds1", name: "Docs", properties: { Name: "title", Status: "checkbox" } }] });
  await assert.rejects(load({ database: DB, publishedValue: "Yes" }), /is a checkbox, which has no values; remove publishedValue/);
  const checked = await load({ database: DB });
  assert.equal(checked.entries.get("one")!.data.draft, undefined);
  assert.equal(checked.entries.get("two")!.data.draft, true);
});

test("drafts, the no-published warning, duplicate and empty ids, a deleted row, and a missing token", async () => {
  api.set(base([page("p1", "One", { slug: "one", status: "Published", description: "First.", order: 2 }), page("p2", "Two", { slug: "two", status: "Draft" })]));
  const drafts = await load({ database: DB });
  assert.deepEqual(drafts.entries.get("one")!.data, { title: "One", description: "First.", sidebar: { order: 2 } });
  assert.equal(drafts.entries.get("two")!.data.draft, true);
  assert.match(drafts.entries.get("two")!.body!, /Two body\./, "a draft keeps its body");

  api.set(base([page("p1", "One", { slug: "one", status: "Done" }), page("p2", "Two", { slug: "two", status: "In progress" })]));
  const allDrafts = await load({ database: DB });
  assert.ok(allDrafts.logs.some((line) => /no row is published[\s\S]*this database uses "Done", "In progress"\. Set publishedValue/.test(line)), allDrafts.logs.join("\n"));
  assert.ok(!(await load({ database: DB, publishedValue: "Done" })).logs.some((line) => /no row is published/.test(line)));

  api.set(base([page("p1", "One", { slug: "same", status: "Published" }), page("p2", "Two", { slug: "same", status: "Draft" })]));
  const strict = context();
  strict.entries.set("kept", { id: "kept", data: {} });
  strict.ctx.parseData = async ({ data }) => {
    if (data.title === "Two") throw new Error("schema: Two is missing a field");
    return data;
  };
  api.set(base([page("p1", "One", { slug: "one", status: "Published" }), page("p2", "Two", { slug: "two", status: "Published" })]));
  await assert.rejects(load({ database: DB }, strict), /schema: Two/);
  assert.deepEqual([...strict.entries.keys()], ["kept"], "a page failing the schema writes nothing");

  api.set(base([page("p1", "One", { slug: "same", status: "Published" }), page("p2", "Two", { slug: "same", status: "Draft" })]));
  const state = context();
  state.entries.set("kept", { id: "kept", data: {} });
  await assert.rejects(load({ database: DB }, state), /two Notion pages give the URL id "same": p1 \("One"\) and p2 \("Two"\)/);
  assert.deepEqual([...state.entries.keys()], ["kept"], "nothing written");

  api.set(base([page("p1", "One", { slug: "one", status: "Published" })]));
  assert.deepEqual([...(await load({ database: DB }, state)).entries.keys()], ["one"], "a row gone from Notion leaves the store");

  api.set(base([page("p9", "", { status: "Published" })]));
  await assert.rejects(load({ database: DB }), /Notion page p9 has no Slug and its title gives no URL/);

  const saved = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    await assert.rejects(mod.notionLoader({ database: DB, fetch: viaFake }).load(context().ctx as never), /NOTION_TOKEN is not set/);
  } finally {
    if (saved !== undefined) process.env.NOTION_TOKEN = saved;
  }
});

test("requests: rows and blocks paginate, children nest, 429 and a 503 block read retry, a 503 query fails untouched", async () => {
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
  assert.match(loaded.entries.get("a")!.body!, /- level 1\n\s+- level 2\n\s+- level 3/);

  const state = context();
  state.entries.set("kept", { id: "kept", data: {} });
  api.fail({ method: "POST", path: /\/query$/, status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "Busy." } });
  await assert.rejects(load({ database: DB }, state), /reading Notion failed, nothing was written: Busy\.$/);
  assert.deepEqual([...state.entries.keys()], ["kept"]);
});

test("blocks become Markdown: headings move down a level, text an editor typed renders as written, code stays as typed", async () => {
  api.set(
    base([
      page("p1", "One", {
        slug: "one",
        status: "Published",
        blocks: [
          { type: "heading_1", text: ["Intro"] },
          { type: "paragraph", text: ["Use {props} and <Tag> *here* with a ", { text: "link", href: "/setup/" }, " and ", { text: "a_b", code: true }, "."] },
          { type: "code", text: ["# not a heading\n~~~\n# still code\nconst x = <T>{} * 2;"], language: "javascript" },
          { type: "to_do", text: ["done"], checked: true },
          { type: "table", rows: [["Key", "Value"], ["a", "1"]] },
          { type: "image", url: "https://example.test/logo.png", text: ["Logo"] },
          { type: "bookmark", url: "https://example.test/a_b" },
          { type: "audio", text: [] },
          { type: "table_of_contents", text: [] },
          { type: "child_page", text: [], children: [{ type: "paragraph", text: ["Sub-page body."] }] },
        ],
      }),
    ]),
  );
  const loaded = await load({ database: DB });
  const body = loaded.entries.get("one")!.body!;
  assert.match(body, /^## Intro$/m);
  assert.doesNotMatch(body, /Sub-page body/, "a sub-page's content stays out");
  assert.match(body, /Use \\\{props\\\} and \\<Tag\\> \\\*here\\\* with a \[link\]\(\/setup\/\) and `a_b`\./);
  assert.match(body, /```javascript\n# not a heading\n~~~\n# still code\nconst x = <T>\{\} \* 2;\n```/);
  assert.match(body, /- \[x\] done/);
  assert.match(body, /\| Key \| Value \|/);
  assert.match(body, /!\[Logo\]\(https:\/\/example\.test\/logo\.png\)/);
  assert.match(body, /\[https:\/\/example\.test\/a_b\]\(https:\/\/example\.test\/a_b\)/, "a bookmark links with its URL");
  assert.ok(loaded.logs.some((line) => /warn notionLoader: audio, table_of_contents, child_page blocks were left out \(no Markdown form, and a row's sub-pages aren't pages of the collection\)/.test(line)), loaded.logs.join("\n"));
});

test("text an editor typed renders as typed, with math, directives, superscript and subscript on", async () => {
  // [typed, the text it renders as]: a soft break stays a newline; indents after one go.
  const cases: Array<[string, string]> = [
    ["1999. That was the year.", "1999. That was the year."],
    ["  1999. three", "1999. three"],
    ["2) second", "2) second"],
    ["Visit https://example.com/a_b_c and www.example.com/a_b", "Visit https://example.com/a_b_c and www.example.com/a_b"],
    ["&copy; 2026", "&copy; 2026"],
    ["line\n- x", "line\n- x"],
    ["line\n   - y", "line\n- y"],
    ["Title\n===", "Title\n==="],
    ["Rule\n---", "Rule\n---"],
    ["$5 and $10", "$5 and $10"],
    ["Note:important", "Note:important"],
    ["Ratio 3:1 at 10:30, back 9:05am", "Ratio 3:1 at 10:30, back 9:05am"],
    ["x^2^ and H~2~O", "x^2^ and H~2~O"],
    ["Use {props} and <Tag> *here*", "Use {props} and <Tag> *here*"],
    ["a\n    indented", "a\nindented"],
  ];
  api.set(base([page("p1", "One", { slug: "one", status: "Published", blocks: cases.map(([text]) => ({ type: "paragraph", text: [text] })) })]));
  const body = (await load({ database: DB })).entries.get("one")!.body!;
  const { html } = markdownToHtml(body, { features: { math: true, directive: true, superscript: true, subscript: true } });
  const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]!);
  assert.equal(paragraphs.length, cases.length, `every case is one plain paragraph:\n${html}`);
  cases.forEach(([typed, rendered], i) => {
    assert.doesNotMatch(paragraphs[i]!, /<(?!a[ >]|\/a>)/, `${JSON.stringify(typed)} became markup: ${paragraphs[i]}`);
    assert.equal(decode(paragraphs[i]!.replace(/<\/?a[^>]*>/g, "")), rendered, JSON.stringify(typed));
  });
  for (const href of html.matchAll(/href="([^"]*)"/g)) assert.doesNotMatch(href[1]!, /%5C|\\/, `broken href ${href[1]}`);
});
