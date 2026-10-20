import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import type { LoaderContext } from "astro/loaders";

import {
  bakePreparedHeadings,
  configureAgentEndpointAssetRoot,
  preparedHeadingsPlugin,
} from "../src/_internal/agent-endpoint-assets.ts";
import { lazyPreparedHeadingRecord } from "../src/_internal/lazy-headings.ts";
import { prepareMarkdownLoader } from "../src/_internal/markdown-loader.ts";
import {
  beginPreparedMarkdownSession,
  clearPreparedMarkdownRegistry,
  getPreparedMarkdownSnapshot,
} from "../src/_internal/prepared-markdown-registry.ts";

const roots: string[] = [];

afterEach(async () => {
  clearPreparedMarkdownRegistry();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true })));
});

interface Entry {
  id: string;
  body: string;
  filePath: string;
  data: Record<string, unknown>;
}

const slug = (text: string) => text.toLowerCase().replace(/\W+/gu, "-");

/** Headings are the `#` lines of the source, so a render is observable. */
function headingsOf(source: string) {
  return [...source.matchAll(/^(#{1,6}) (.+)$/gmu)].map((match) => ({
    depth: match[1]!.length,
    text: match[2]!,
    slug: slug(match[2]!),
  }));
}

async function load(
  root: string,
  collection: string,
  entries: Entry[],
  renders: string[],
) {
  const store = new Map<string, Entry>();
  const meta = new Map<string, string>();
  const context = {
    collection,
    store: {
      get: (id: string) => store.get(id),
      entries: () => store.entries(),
      values: () => store.values(),
      keys: () => store.keys(),
      set: (entry: Entry) => store.set(entry.id, entry) && true,
      delete: (id: string) => store.delete(id),
      clear: () => store.clear(),
      has: (id: string) => store.has(id),
    },
    meta: {
      get: (key: string) => meta.get(key),
      set: (key: string, value: string) => meta.set(key, value),
      has: (key: string) => meta.has(key),
      delete: (key: string) => meta.delete(key),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {}, fork() { return this; } },
    config: {
      root: pathToFileURL(`${root}${path.sep}`),
      srcDir: new URL("src/", pathToFileURL(`${root}${path.sep}`)),
      base: "/",
    },
    async renderMarkdown(source: string) {
      renders.push(`${collection}:${source}`);
      return {
        html: source,
        metadata: { headings: headingsOf(source), imagePaths: [] },
      };
    },
    generateDigest: (source: unknown) => JSON.stringify(source),
    entryTypes: new Map(),
  } as unknown as LoaderContext;
  await prepareMarkdownLoader(
    {
      name: `${collection}-loader`,
      load(ctx: LoaderContext) {
        for (const entry of entries) ctx.store.set(entry);
      },
    },
    {
      generation: 1,
      base: "/",
      transform: (source) => source,
      role: collection === "partials" ? "partials" : "page",
    },
  ).load(context);
}

const page = (id: string, body: string, ext = "mdx"): Entry => ({
  id,
  body,
  filePath: `src/content/docs/${id}.${ext}`,
  data: {},
});
const partial = (id: string, body: string): Entry => ({
  id,
  body,
  filePath: `src/content/partials/${id}.mdx`,
  data: {},
});

async function fixture(lazy: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-lazy-headings-"));
  roots.push(root);
  beginPreparedMarkdownSession(root, { lazyHeadings: lazy });
  const renders: string[] = [];
  await load(
    root,
    "partials",
    [
      partial("inner", "### Inner"),
      partial("outer", '## Outer\n\n<Render file="inner" />'),
    ],
    renders,
  );
  await load(
    root,
    "docs",
    [
      page("guide", '# Guide\n\n<Render file="outer" />\n\n## After'),
      page("missing", '# Missing\n\n<Render file="nope" />'),
      page("plain", "# Plain\n\n## Two", "md"),
    ],
    renders,
  );
  return { root, renders };
}

test("lazy mode defers heading renders until a page is requested", async () => {
  const { root, renders } = await fixture(true);
  assert.deepEqual(renders, []);
  const entry = getPreparedMarkdownSnapshot(root)
    ?.collections.get("docs")
    ?.entries.get("guide");
  assert.equal(entry?.headings, undefined);

  const record = await lazyPreparedHeadingRecord(
    { root, base: "/" },
    "docs",
    "guide",
  );
  assert.deepEqual(
    record?.headings.map((heading) => heading.slug),
    ["guide", "outer", "inner", "after"],
  );
  // The page and the two partials it reaches; nothing else.
  assert.equal(renders.length, 3);
  await lazyPreparedHeadingRecord({ root, base: "/" }, "docs", "guide");
  assert.equal(renders.length, 3);
});

test("lazy records match the eager bake", async () => {
  const eager = await fixture(false);
  const eagerRecords = await bakePreparedHeadings({
    root: eager.root,
    base: "/",
  });
  clearPreparedMarkdownRegistry();
  const lazy = await fixture(true);
  for (const expected of eagerRecords) {
    assert.deepEqual(
      await lazyPreparedHeadingRecord(
        { root: lazy.root, base: "/" },
        expected.collection,
        expected.id,
      ),
      expected,
    );
  }
  assert.equal(eagerRecords.length, 3);
  assert.equal(
    await lazyPreparedHeadingRecord({ root: lazy.root, base: "/" }, "partials", "inner"),
    null,
  );
  assert.equal(
    await lazyPreparedHeadingRecord({ root: lazy.root, base: "/" }, "docs", "absent"),
    null,
  );
});

test("a changed body is rendered again", async () => {
  const { root, renders } = await fixture(true);
  await lazyPreparedHeadingRecord({ root, base: "/" }, "docs", "plain");
  const before = renders.length;
  await load(root, "docs", [page("plain", "# Renamed", "md")], renders);
  const record = await lazyPreparedHeadingRecord(
    { root, base: "/" },
    "docs",
    "plain",
  );
  assert.deepEqual(
    record?.headings.map((heading) => heading.slug),
    ["renamed"],
  );
  assert.equal(renders.length, before + 1);
});

test("dev serves one module per page and invalidates them on update", async () => {
  const { root } = await fixture(true);
  configureAgentEndpointAssetRoot(
    root,
    "dev",
    async () => {
      throw new Error("no asset bake");
    },
    async () => {
      throw new Error("no eager bake");
    },
    "/",
    (collection, id) =>
      lazyPreparedHeadingRecord({ root, base: "/" }, collection, id),
  );
  const plugin = preparedHeadingsPlugin(root);
  const index = await plugin.load(plugin.resolveId("virtual:nimbus/headings")!);
  assert.match(index ?? "", /export const records = \[\]/u);
  assert.match(index ?? "", /export function load/u);

  const entryId = plugin.resolveId(
    `virtual:nimbus/headings/${Buffer.from(JSON.stringify(["docs", "plain"])).toString("base64url")}`,
  )!;
  const source = (await plugin.load(entryId)) ?? "";
  assert.match(source, /"collection":"docs","id":"plain"/u);
  assert.doesNotMatch(source, /guide/u);

  const invalidated: unknown[] = [];
  const modules = new Map<string, object>([
    [entryId, { entry: true }],
    [plugin.resolveId("virtual:nimbus/headings")!, { index: true }],
  ]);
  plugin.handleHotUpdate({
    server: {
      moduleGraph: {
        getModuleById: (id) => modules.get(id),
        invalidateModule: (module) => invalidated.push(module),
      },
    },
  });
  assert.deepEqual(invalidated, [{ index: true }, { entry: true }]);
});
