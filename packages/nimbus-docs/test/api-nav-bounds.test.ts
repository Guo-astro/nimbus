// Bounded API navigation: the one rule behind `api[].sidebar` ("full",
// "on-demand", "links"). Every output path goes through `applyApiSidebarMode`,
// so these tests pin the rule itself, `getApiNav`, the static projection, and
// the prepared (server) nav against each other for every coordinate.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { apiCollection } from "../src/content.js";
import {
  activatePreparedApiNav,
  prepareApiNav,
} from "../src/_internal/api/prepared.js";
import {
  apiNavFragmentHref,
  apiNavGroupChildren,
  apiNavRevision,
  apiNavGroupKey,
  apiNavGroups,
  applyApiSidebarMode,
} from "../src/_internal/api/nav-bounds.js";
import { projectConfiguredApiPage } from "../src/_internal/api-loader.js";
import { registerApiCollections } from "../src/_internal/api-collection-registry.js";
import { validateNimbusConfig } from "../src/_internal/validate.js";
import {
  boundApiNav,
  buildApiModel,
  getApiNav,
  getApiPageSlugs,
  type ApiModel,
  type ApiNav,
  type ApiNavItem,
  type ApiSidebarMode,
} from "../src/api/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
const coordinates = () => [
  undefined,
  ...getApiPageSlugs(model).map((page) => page.coordinate),
];

describe("sidebar: full", () => {
  test("is the default and leaves getApiNav unchanged for every page", () => {
    for (const coordinate of coordinates()) {
      const nav = getApiNav(model, coordinate);
      assert.deepEqual(getApiNav(model, coordinate, { sidebar: "full" }), nav);
      assert.equal(JSON.stringify(nav).includes('"deferred"'), false);
      assert.equal(boundApiNav(nav, { mode: "full" }), nav, "same object");
    }
  });
});

describe("sidebar: on-demand", () => {
  test("a root page shows top-level items; page-less categories keep their direct children", () => {
    const nav = getApiNav(model, undefined, { sidebar: "on-demand" });
    assert.deepEqual(
      nav.items.map((item) => [item.label, item.deferred, item.children.length]),
      [
        ["Loose", true, 0],
        ["Compute & Storage", undefined, 2],
        ["Networking", undefined, 1],
      ],
    );
    // Without JavaScript a page-less group has nothing to link to, so its
    // children are in the page; each child is itself collapsed.
    const compute = byLabel(nav.items, "Compute & Storage");
    assert.equal(compute.childrenHref, undefined, "nothing to load");
    assert.deepEqual(
      compute.children.map((c) => [c.label, c.deferred, Boolean(c.childrenHref)]),
      [
        ["Workers", true, true],
        ["KV", true, true],
      ],
    );
  });

  test("an operation page opens its trail; siblings stay collapsed", () => {
    const nav = getApiNav(model, "scriptsPut", { sidebar: "on-demand" });
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
    const networking = byLabel(nav.items, "Networking");
    assert.equal(networking.deferred, undefined, "page-less: never deferred");
    assert.equal(byLabel(networking.children, "DNS").deferred, true);
  });

  test("open groups on the trail still name their fragment, for caching", () => {
    const nav = getApiNav(model, "scriptsPut", { sidebar: "on-demand" });
    const compute = byLabel(nav.items, "Compute & Storage");
    const revision = apiNavRevision(getApiNav(model));
    assert.equal(compute.childrenHref, undefined, "page-less: never collapsed into a fragment");
    const workers = byLabel(compute.children, "Workers");
    assert.equal(workers.childrenHref, apiNavFragmentHref("/bounded", workers.coordinate, revision));
  });

  test("a tag page shows its own children, each collapsed", () => {
    const nav = getApiNav(model, "tags.Workers", { sidebar: "on-demand" });
    const workers = byLabel(byLabel(nav.items, "Compute & Storage").children, "Workers");
    assert.equal(workers.active, true);
    assert.equal(byLabel(workers.children, "Scripts").deferred, true);
  });

  test("every deferred group has a fragment URL", () => {
    const nav = getApiNav(model, undefined, { sidebar: "on-demand" });
    const deferred = flatten(nav.items).filter((item) => item.deferred);
    assert.equal(deferred.length, 4);
    for (const item of deferred) {
      assert.equal(
        item.childrenHref,
        apiNavFragmentHref("/bounded", item.coordinate, apiNavRevision(getApiNav(model))),
      );
      assert.match(item.childrenHref!, /^\/nimbus-api\/nav\/bounded\/[a-z0-9-]+\/\?v=[0-9a-f]{8}$/);
    }
  });

  test("fragment URLs share one version per tree, which changes with the tree", async () => {
    const version = (nav: ApiNav) => new URL(nav.items[0]!.childrenHref!, "https://x").searchParams.get("v");
    const first = version(getApiNav(model, "scriptsPut", { sidebar: "on-demand" }));
    assert.ok(first);
    assert.equal(version(getApiNav(model, "tags.Networking", { sidebar: "on-demand" })), first);
    const renamed = JSON.parse(JSON.stringify(spec).replace("Upload a script", "Upload a Worker"));
    const changed = await buildApiModel({ collection: "bounded", spec: renamed });
    assert.notEqual(version(getApiNav(changed, "scriptsPut", { sidebar: "on-demand" })), first);
  });
});

describe("sidebar: links", () => {
  test("a page-less category shows its direct children, each collapsed", () => {
    const nav = getApiNav(model, undefined, { sidebar: "links" });
    const compute = byLabel(nav.items, "Compute & Storage");
    assert.equal(compute.href, undefined);
    assert.equal(compute.deferred, undefined);
    for (const child of compute.children) {
      assert.equal(child.deferred, true);
      assert.equal(typeof child.href, "string", "a collapsed group is a link");
      assert.equal(child.childrenHref, undefined, "links mode loads nothing");
    }
    assert.equal(byLabel(nav.items, "Loose").deferred, true);
  });

  test("links mode never points at fragments", () => {
    for (const coordinate of coordinates()) {
      const nav = getApiNav(model, coordinate, { sidebar: "links" });
      assert.equal(JSON.stringify(nav).includes("childrenHref"), false);
    }
  });

  test("no deferred item in links mode lacks a page", () => {
    for (const coordinate of coordinates()) {
      const nav = getApiNav(model, coordinate, { sidebar: "links" });
      for (const item of flatten(nav.items)) {
        if (item.deferred) assert.ok(item.href, `${item.coordinate} links somewhere`);
      }
    }
  });
});

describe("bounded pages stay reachable and consistent", () => {
  for (const mode of ["on-demand", "links"] as ApiSidebarMode[]) {
    test(`${mode}: every item appears in a page or in its parent's fragment`, () => {
      const full = getApiNav(model);
      const reached = new Set<string>();
      const collect = (items: ApiNavItem[]) =>
        flatten(items).forEach((item) => reached.add(item.coordinate));
      collect(getApiNav(model, undefined, { sidebar: mode }).items);
      for (const group of apiNavGroups(full)) {
        collect(apiNavGroupChildren(full, group.coordinate, { mode }) ?? []);
      }
      for (const item of flatten(full.items)) {
        assert.ok(reached.has(item.coordinate), `${item.coordinate} is reachable`);
      }
    });

    test(`${mode}: every item on a page matches the full tree's row`, () => {
      const strip = ({ children: _c, deferred: _d, childrenHref: _h, ...row }: ApiNavItem) => row;
      for (const coordinate of coordinates()) {
        const full = new Map(
          flatten(getApiNav(model, coordinate).items).map((i) => [i.coordinate, strip(i)]),
        );
        for (const item of flatten(getApiNav(model, coordinate, { sidebar: mode }).items)) {
          assert.deepEqual(strip(item), full.get(item.coordinate));
        }
      }
    });
  }

  test("a fragment carries no page's trail and bounds its own children", () => {
    const full = getApiNav(model, "scriptsPut");
    const children = apiNavGroupChildren(full, "tags.Workers", { mode: "on-demand" })!;
    assert.equal(JSON.stringify(children).match(/"(active|expanded)":true/), null);
    assert.equal(byLabel(children, "Scripts").deferred, true);
    assert.equal(apiNavGroupChildren(full, "scriptsPut", { mode: "on-demand" }), undefined);
    assert.equal(apiNavGroupChildren(full, "missing", { mode: "on-demand" }), undefined);
  });

  test("group keys are URL-safe, distinct, and stable", () => {
    const keys = apiNavGroups(getApiNav(model)).map((g) => apiNavGroupKey(g.coordinate));
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) assert.match(key, /^[a-z0-9-]+-[0-9a-f]{8}$/);
    assert.equal(apiNavGroupKey("tags.A B"), apiNavGroupKey("tags.A B"));
    assert.notEqual(apiNavGroupKey("tags.A B"), apiNavGroupKey("tags.A-B"));
  });

  test("prepared (server) navigation bounds identically for every coordinate", () => {
    const prepared = prepareApiNav(getApiNav(model));
    for (const mode of ["full", "on-demand", "links"] as ApiSidebarMode[]) {
      for (const coordinate of coordinates()) {
        if (!coordinate) continue;
        assert.deepEqual(
          applyApiSidebarMode(activatePreparedApiNav(prepared, coordinate), mode, "/bounded", prepared.revision),
          getApiNav(model, coordinate, { sidebar: mode }),
          `${mode} ${coordinate}`,
        );
      }
    }
  });

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

  test("the static projection applies the configured mode", async () => {
    registerApiCollections(pathToFileURL(ROOT), [{ collection: "bounded", spec, sidebar: "on-demand" }]);
    await loadInto(apiCollection().loader);
    for (const coordinate of coordinates()) {
      if (!coordinate) continue;
      const { nav } = await projectConfiguredApiPage("bounded", null, coordinate);
      assert.deepEqual(nav, getApiNav(model, coordinate, { sidebar: "on-demand" }));
    }
  });

  test("explicit loader options take the mode from the config, which owns the fragment routes", async () => {
    // A mode on the loader alone would bound pages whose fragment routes were never injected.
    registerApiCollections(pathToFileURL(ROOT), [{ collection: "bounded", spec, sidebar: "links" }]);
    await loadInto(apiCollection({ collection: "bounded", spec }).loader);
    const { nav } = await projectConfiguredApiPage("bounded", null, "scriptsPut");
    assert.deepEqual(nav, getApiNav(model, "scriptsPut", { sidebar: "links" }));

    registerApiCollections(pathToFileURL(ROOT), []);
    await loadInto(apiCollection({ collection: "bounded", spec }).loader);
    const unconfigured = await projectConfiguredApiPage("bounded", null, "scriptsPut");
    assert.deepEqual(unconfigured.nav, getApiNav(model, "scriptsPut"), "no config entry: full");
  });
});

describe("config", () => {
  const base = { site: "https://example.com", title: "T" };
  test("accepts the three modes", () => {
    for (const sidebar of ["full", "on-demand", "links"]) {
      assert.doesNotThrow(() =>
        validateNimbusConfig({ ...base, api: [{ collection: "api", spec: "./a.yaml", sidebar }] }),
      );
    }
  });
  test("rejects anything else with a readable message", () => {
    assert.throws(
      () => validateNimbusConfig({ ...base, api: [{ collection: "api", spec: "./a.yaml", sidebar: "lazy" }] }),
      /"api\[\]\.sidebar" must be "full", "on-demand", or "links"/,
    );
  });
});
