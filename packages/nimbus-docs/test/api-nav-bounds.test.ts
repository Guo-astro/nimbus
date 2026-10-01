// Bounded API navigation: the rule behind `api[].sidebar: "on-demand"`. Every
// output path goes through `applyApiSidebarMode`, so these tests pin the rule
// itself, and the static projection and the prepared (server) nav against it,
// for every page.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { apiCollection } from "../src/content.js";
import {
  activatePreparedApiNav,
  prepareApiNav,
} from "../src/_internal/api/prepared.js";
import { apiNavGroups, applyApiSidebarMode } from "../src/_internal/api/nav-bounds.js";
import { toDocumentHref } from "../src/_internal/url.js";
import { projectConfiguredApiPage } from "../src/_internal/api-loader.js";
import { registerApiCollections } from "../src/_internal/api-collection-registry.js";
import { validateNimbusConfig } from "../src/_internal/validate.js";
import {
  buildApiModel,
  getApiNav,
  getApiPageSlugs,
  type ApiModel,
  type ApiNav,
  type ApiNavItem,
} from "../src/api/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MOUNT = "/bounded";

const ok = { "200": { description: "ok" } };

// Two x-tagGroups categories (page-less), one nested subresource, one
// ungrouped tag — every shape the rule distinguishes.
const spec = {
  openapi: "3.1.0",
  info: { title: "Bounded", version: "1" },
  "x-tagGroups": [
    { name: "Compute & Storage", tags: ["Workers", "KV"] },
    { name: "Networking", tags: ["DNS"] },
  ],
  tags: [
    { name: "Workers" },
    { name: "Scripts", parent: "Workers" },
    { name: "KV" },
    { name: "DNS" },
    { name: "Loose" },
  ],
  paths: {
    "/workers": {
      get: { operationId: "workersList", summary: "List Workers", tags: ["Workers"], responses: ok },
    },
    "/workers/scripts": {
      get: { operationId: "scriptsList", summary: "List scripts", tags: ["Scripts"], responses: ok },
      put: { operationId: "scriptsPut", summary: "Upload a script", tags: ["Scripts"], responses: ok },
    },
    "/kv": {
      get: { operationId: "kvList", summary: "List namespaces", tags: ["KV"], responses: ok },
    },
    "/dns": {
      get: { operationId: "dnsList", summary: "List records", tags: ["DNS"], responses: ok },
    },
    "/loose": {
      get: { operationId: "looseGet", summary: "Get loose", tags: ["Loose"], responses: ok },
    },
  },
} as Record<string, unknown>;

let model: ApiModel;
before(async () => {
  model = await buildApiModel({ collection: "bounded", spec });
});

const byLabel = (items: ApiNavItem[], label: string) => {
  const item = items.find((i) => i.label === label);
  assert.ok(item, `nav has "${label}"`);
  return item;
};
const flatten = (items: ApiNavItem[]): ApiNavItem[] =>
  items.flatMap((item) => [item, ...flatten(item.children)]);
const coordinates = () => getApiPageSlugs(model).map((page) => page.coordinate);
const OVERVIEW = "bounded";

/** The on-demand nav a page renders, as every output path computes it. */
const pageNav = (coordinate: string): ApiNav =>
  applyApiSidebarMode(getApiNav(model, coordinate), {
    mode: "on-demand",
    mountPath: MOUNT,
    overview: coordinate === OVERVIEW,
  });

/** The page an href renders: its coordinate. */
const pageAt = (href: string): string => {
  if (href === toDocumentHref(MOUNT)) return OVERVIEW;
  const item = flatten(getApiNav(model).items).find((i) => i.href === href);
  assert.ok(item, `${href} is a page`);
  return item.coordinate;
};

const find = (items: ApiNavItem[], coordinate: string) =>
  flatten(items).find((i) => i.coordinate === coordinate);

describe("sidebar: full", () => {
  test("returns the nav itself", () => {
    for (const coordinate of coordinates()) {
      const nav = getApiNav(model, coordinate);
      assert.equal(applyApiSidebarMode(nav, { mode: "full", mountPath: MOUNT }), nav);
    }
  });
});

describe("sidebar: on-demand", () => {
  test("an operation page opens its trail; everything else is collapsed", () => {
    const nav = pageNav("scriptsPut");
    const compute = byLabel(nav.items, "Compute & Storage");
    assert.equal(compute.expanded, true);
    assert.equal(compute.deferred, undefined);
    const workers = byLabel(compute.children, "Workers");
    assert.deepEqual(
      workers.children.map((c) => c.label),
      ["List Workers", "Scripts"],
    );
    const scripts = byLabel(workers.children, "Scripts");
    assert.equal(byLabel(scripts.children, "Upload a script").active, true);
    assert.equal(byLabel(compute.children, "KV").deferred, true);
    assert.equal(byLabel(nav.items, "Networking").deferred, true);
    assert.equal(byLabel(nav.items, "Loose").deferred, true);
  });

  test("a collapsed group loads from its own page; a page-less one from the overview", () => {
    const nav = pageNav("looseGet");
    const kv = find(nav.items, "tags.KV");
    assert.equal(kv, undefined, "inside a collapsed category");
    const networking = byLabel(nav.items, "Networking");
    assert.equal(networking.href, undefined);
    assert.equal(networking.childrenHref, toDocumentHref(MOUNT));
    const compute = byLabel(pageNav("dnsList").items, "Compute & Storage");
    assert.equal(compute.childrenHref, toDocumentHref(MOUNT));
    const dns = byLabel(byLabel(pageNav("dnsList").items, "Networking").children, "DNS");
    assert.equal(dns.active, undefined);
    assert.equal(dns.expanded, true, "on the trail: open, nothing to load");
    assert.equal(dns.childrenHref, undefined);
  });

  test("the overview lists every page-less group's children, each collapsed", () => {
    const nav = pageNav(OVERVIEW);
    const compute = byLabel(nav.items, "Compute & Storage");
    assert.deepEqual(
      compute.children.map((c) => [c.label, c.deferred, c.childrenHref]),
      [
        ["Workers", true, byLabel(getApiNav(model).items, "Compute & Storage").children[0]!.href],
        ["KV", true, byLabel(getApiNav(model).items, "Compute & Storage").children[1]!.href],
      ],
    );
    assert.equal(byLabel(nav.items, "Loose").deferred, true);
  });

  test("only collapsed groups carry childrenHref", () => {
    for (const coordinate of coordinates()) {
      for (const item of flatten(pageNav(coordinate).items)) {
        assert.equal(Boolean(item.childrenHref), Boolean(item.deferred), `${coordinate}: ${item.coordinate}`);
        if (item.deferred) assert.equal(item.children.length, 0);
      }
    }
  });

  // The invariant the client relies on: for every collapsed group on every
  // page, the page it names lists that group open, with rows equal to the
  // full tree's, and no row there is the current page.
  test("every collapsed group's rows are on the page it names, without a highlight", () => {
    const full = getApiNav(model);
    let checked = 0;
    for (const coordinate of coordinates()) {
      for (const group of flatten(pageNav(coordinate).items).filter((i) => i.deferred)) {
        const source = pageNav(pageAt(group.childrenHref!));
        const there = find(source.items, group.coordinate);
        assert.ok(there && !there.deferred, `${group.childrenHref} lists ${group.coordinate} open`);
        assert.deepEqual(
          there.children.map((c) => c.coordinate),
          find(full.items, group.coordinate)!.children.map((c) => c.coordinate),
        );
        for (const row of there.children) {
          assert.equal(row.active, undefined, `${row.coordinate} is not highlighted there`);
          assert.equal(row.expanded, undefined);
        }
        checked += 1;
      }
    }
    assert.ok(checked > 10);
  });

  test("every item is reachable from the overview by opening groups", () => {
    const reached = new Set<string>();
    const visit = (items: ApiNavItem[]) => {
      for (const item of items) {
        reached.add(item.coordinate);
        const rows = item.deferred
          ? find(pageNav(pageAt(item.childrenHref!)).items, item.coordinate)!.children
          : item.children;
        visit(rows);
      }
    };
    visit(pageNav(OVERVIEW).items);
    for (const group of apiNavGroups(getApiNav(model))) {
      for (const item of [group, ...group.children]) {
        assert.ok(reached.has(item.coordinate), `${item.coordinate} is reachable`);
      }
    }
  });

  test("every row matches the full tree's row", () => {
    const strip = ({ children: _c, deferred: _d, childrenHref: _h, ...row }: ApiNavItem) => row;
    for (const coordinate of coordinates()) {
      const full = new Map(
        flatten(getApiNav(model, coordinate).items).map((i) => [i.coordinate, strip(i)]),
      );
      for (const item of flatten(pageNav(coordinate).items)) {
        assert.deepEqual(strip(item), full.get(item.coordinate));
      }
    }
  });

  test("prepared (server) navigation bounds identically for every page", () => {
    const prepared = prepareApiNav(getApiNav(model));
    for (const coordinate of coordinates()) {
      assert.deepEqual(
        applyApiSidebarMode(activatePreparedApiNav(prepared, coordinate), {
          mode: "on-demand",
          mountPath: MOUNT,
          overview: coordinate === OVERVIEW,
        }),
        pageNav(coordinate),
        coordinate,
      );
    }
  });
});

describe("the configured mode", () => {
  const loadInto = async (loader: ReturnType<typeof apiCollection>["loader"]) => {
    const store = new Map<string, unknown>();
    await loader.load({
      collection: "bounded",
      store: {
        set: (entry: { id: string }) => void store.set(entry.id, entry),
        get: (id: string) => store.get(id),
        keys: () => [...store.keys()],
        values: () => [...store.values()],
        entries: () => [...store.entries()],
        has: (id: string) => store.has(id),
        delete: (id: string) => void store.delete(id),
        clear: () => store.clear(),
        addModuleImport() {},
      },
      meta: { get: () => undefined, set() {}, has: () => false, delete() {} },
      logger: { info() {}, warn() {}, error() {}, debug() {}, label: "t", fork() { return this; } },
      config: { root: pathToFileURL(ROOT), output: "static" },
      parseData: async ({ data }: { data: unknown }) => data,
      renderMarkdown: async () => ({ html: "" }),
      generateDigest: (v: unknown) => JSON.stringify(v).length.toString(36),
      watcher: undefined,
    } as never);
  };

  test("the static projection applies it, overview included", async () => {
    registerApiCollections(pathToFileURL(ROOT), [{ collection: "bounded", spec, sidebar: "on-demand" }]);
    await loadInto(apiCollection().loader);
    for (const coordinate of coordinates()) {
      const { nav } = await projectConfiguredApiPage("bounded", null, coordinate);
      assert.deepEqual(nav, pageNav(coordinate), coordinate);
    }
  });

  test("comes from the config entry, not the loader options", async () => {
    registerApiCollections(pathToFileURL(ROOT), []);
    await loadInto(apiCollection({ collection: "bounded", spec }).loader);
    const unconfigured = await projectConfiguredApiPage("bounded", null, "scriptsPut");
    assert.deepEqual(unconfigured.nav, getApiNav(model, "scriptsPut"), "no config entry: full");
  });
});

describe("config", () => {
  const base = { site: "https://example.com", title: "T" };
  test("accepts the two modes", () => {
    for (const sidebar of ["full", "on-demand"]) {
      assert.doesNotThrow(() =>
        validateNimbusConfig({ ...base, api: [{ collection: "api", spec: "./a.yaml", sidebar }] }),
      );
    }
  });
  test("rejects anything else with a readable message", () => {
    for (const sidebar of ["links", "lazy"]) {
      assert.throws(
        () => validateNimbusConfig({ ...base, api: [{ collection: "api", spec: "./a.yaml", sidebar }] }),
        /"api\[\]\.sidebar" must be "full" or "on-demand"/,
      );
    }
  });
});
