// An isolated rail replaces its group, so the group's landing page leads the
// rail instead of vanishing with the group heading.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree, isolateToBoundary, scopeToCurrentSection } from "../src/_internal/sidebar.js";
import { getPrevNext } from "../src/_internal/navigation.js";
import type { SidebarItem } from "../src/types.js";

const config = { items: [{ label: "LP", items: [{ autogenerate: { directory: "lp" } }] }], scope: "section" };

const entries = [
  { id: "lp/kv", data: { title: "KV", sidebar: { order: 1 } } },
  { id: "lp/kv/get", data: { title: "Get", sidebar: { order: 1 } } },
  { id: "lp/kv/put", data: { title: "Put", sidebar: { order: 2 } } },
  { id: "lp/d1", data: { title: "D1", sidebar: { order: 2 } } },
  { id: "lp/d1/query", data: { title: "Query", sidebar: { order: 1 } } },
];

function isolate(slug: string, list = entries, overviewLabel?: string): SidebarItem[] {
  const tree = buildSidebarTree({ docs: list } as any, "docs", slug, config as any);
  return isolateToBoundary(scopeToCurrentSection(tree, slug), slug, ["lp/*"], overviewLabel);
}

const rail = (items: SidebarItem[]) =>
  items.map((item) => (item.type === "link" ? [item.label, item.href, item.isCurrent] : [item.label]));

test("the landing leads the rail under the group's label", () => {
  assert.deepEqual(rail(isolate("/lp/kv/get")), [
    ["KV", "/lp/kv/", false],
    ["Get", "/lp/kv/get/", true],
    ["Put", "/lp/kv/put/", false],
  ]);
});

test("on the landing itself, the rail keeps it and marks it current", () => {
  assert.deepEqual(rail(isolate("/lp/kv")), [
    ["KV", "/lp/kv/", true],
    ["Get", "/lp/kv/get/", false],
    ["Put", "/lp/kv/put/", false],
  ]);
});

test("the landing gains its neighbours", () => {
  assert.deepEqual(getPrevNext("/lp/kv/", isolate("/lp/kv")), {
    prev: undefined,
    next: { label: "Get", href: "/lp/kv/get/" },
  });
});

test("overview-leaf mode names the landing with the overview label unless the page sets one", () => {
  assert.equal(isolate("/lp/kv/get", entries, "Overview")[0]!.label, "Overview");
  const labelled = entries.map((entry) =>
    entry.id === "lp/kv" ? { ...entry, data: { ...entry.data, sidebar: { order: 1, label: "About KV" } } } : entry,
  );
  assert.equal(isolate("/lp/kv/get", labelled, "Overview")[0]!.label, "About KV");
});

test("a group without a landing isolates to its children alone", () => {
  const list = entries.filter((entry) => entry.id !== "lp/kv");
  assert.deepEqual(rail(isolate("/lp/kv/get", list)), [
    ["Get", "/lp/kv/get/", true],
    ["Put", "/lp/kv/put/", false],
  ]);
});

test("an off-site or cross-section landing isn't added", () => {
  for (const external_link of ["https://example.com/kv", "/elsewhere/"]) {
    const list = entries.map((entry) =>
      entry.id === "lp/kv" ? { ...entry, data: { ...entry.data, external_link } } : entry,
    );
    assert.deepEqual(rail(isolate("/lp/kv/get", list)), [
      ["Get", "/lp/kv/get/", true],
      ["Put", "/lp/kv/put/", false],
    ]);
  }
});

test("a landing a child already links isn't repeated", () => {
  const tree = buildSidebarTree({ docs: entries } as any, "docs", "/lp/kv/get", config as any);
  const scoped = scopeToCurrentSection(tree, "/lp/kv/get");
  const group = scoped[0] as Extract<SidebarItem, { type: "group" }>;
  group.children.unshift({ type: "link", label: "Start", href: "/lp/kv/", isCurrent: false, order: 0 });
  assert.deepEqual(rail(isolateToBoundary(scoped, "/lp/kv/get", ["lp/*"])), [
    ["Start", "/lp/kv/", false],
    ["Get", "/lp/kv/get/", true],
    ["Put", "/lp/kv/put/", false],
  ]);
});
