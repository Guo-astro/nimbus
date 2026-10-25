// A labeled collection group links its landing at any depth: `/sdk` as well
// as `/products/sdk`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree } from "../src/_internal/sidebar.js";
import { getPrevNext } from "../src/_internal/navigation.js";
import type { SidebarConfig, SidebarItem } from "../src/types.js";

const page = (id: string, title: string, sidebar?: Record<string, unknown>) => ({ id, data: { title, sidebar } });

function build(mount: string, landing = page("index", "SDK"), path = "/x"): SidebarItem[] {
  const entries = { docs: [page("guides", "Guides")], sdk: [landing, page("a", "A"), page("b", "B")] };
  const config = { items: [{ label: "Guides", link: "/guides/" }, { label: "SDK", autogenerate: { collection: "sdk" } }] };
  return buildSidebarTree(entries as never, "docs", path, config as SidebarConfig, "", new Set(), (c) =>
    c === "sdk" ? mount : `/${c}`,
  );
}

for (const mount of ["/sdk", "/products/sdk"]) {
  test(`a labeled group at ${mount} links its landing, which joins prev/next`, () => {
    const group = build(mount)[1];
    assert.equal(group?.type === "group" && group.indexHref, `${mount}/`);
    assert.deepEqual(getPrevNext(`${mount}/a/`, build(mount)).prev, { label: "SDK", href: `${mount}/` });
  });
}

test("hideIndex keeps a plain heading", () => {
  const group = build("/sdk", page("index", "SDK", { group: { hideIndex: true } }))[1];
  assert.equal(group?.type === "group" && group.indexHref, undefined);
});
