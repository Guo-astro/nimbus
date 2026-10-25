// API pages link to their neighbours in sidebar order, including pages a
// bounded (on-demand) sidebar collapses away.

import assert from "node:assert/strict";
import { test } from "node:test";

import { activatePreparedApiNav, prepareApiNav } from "../src/_internal/api/prepared.js";
import { applyApiSidebarMode } from "../src/_internal/api/nav-bounds.js";
import type { ApiNav, ApiNavItem } from "../src/_internal/api/api-view-types.js";

const item = (coordinate: string, href: string | undefined, children: ApiNavItem[] = []): ApiNavItem => ({
  coordinate,
  label: coordinate,
  kind: "operation",
  href,
  children,
});

const nav: ApiNav = {
  apiSchemaVersion: 1,
  collection: "api",
  items: [
    item("zones", "/api/zones/", [item("listZones", "/api/zones/list/"), item("getZone", "/api/zones/get/")]),
    item("Admin", undefined, [item("listUsers", "/api/users/list/")]),
  ],
};
const prepared = prepareApiNav(nav);

test("neighbours follow sidebar order across groups, even when collapsed", () => {
  const at = (coordinate: string) => activatePreparedApiNav(prepared, coordinate).prevNext;
  assert.deepEqual(at("zones"), { next: { label: "listZones", href: "/api/zones/list/" } });
  assert.deepEqual(at("getZone"), {
    prev: { label: "listZones", href: "/api/zones/list/" },
    next: { label: "listUsers", href: "/api/users/list/" },
  });
  assert.deepEqual(at("listUsers"), { prev: { label: "getZone", href: "/api/zones/get/" } });

  const bounded = applyApiSidebarMode(activatePreparedApiNav(prepared, "listUsers"), {
    mode: "on-demand",
    mountPath: "/api",
  });
  assert.equal(bounded.items[0]!.children.length, 0, "the zones group is collapsed");
  assert.deepEqual(bounded.prevNext, { prev: { label: "getZone", href: "/api/zones/get/" } });
});
