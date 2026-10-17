// A page the sidebar reaches twice never becomes its own neighbour.

import assert from "node:assert/strict";
import { test } from "node:test";

import { getPrevNext } from "../src/_internal/navigation.js";
import type { SidebarItem } from "../src/types.js";

const link = (label: string, href: string): SidebarItem => ({ type: "link", label, href, isCurrent: false });
const group = (label: string, indexHref: string | undefined, children: SidebarItem[]): SidebarItem =>
  ({ type: "group", label, indexHref, children, collapsed: false }) as SidebarItem;

test("a landing that's also a child link", () => {
  const tree = [link("A", "/a/"), group("Guides", "/guides/", [link("Overview", "/guides/"), link("B", "/guides/b/")]), link("C", "/c/")];
  assert.deepEqual(getPrevNext("/guides/", tree), {
    prev: { label: "A", href: "/a/" },
    next: { label: "B", href: "/guides/b/" },
  });
  assert.deepEqual(getPrevNext("/guides/b/", tree).prev, { label: "Guides", href: "/guides/" });
});

test("a page linked from two groups", () => {
  const tree = [group("One", undefined, [link("A", "/a/"), link("Shared", "/shared/")]), group("Two", undefined, [link("Shared", "/shared/"), link("B", "/b/")])];
  assert.deepEqual(getPrevNext("/shared/", tree), {
    prev: { label: "A", href: "/a/" },
    next: { label: "B", href: "/b/" },
  });
});

test("an anchor link after its page", () => {
  const tree = [link("A", "/a/"), link("A, setup", "/a/#setup"), link("B", "/b/")];
  assert.deepEqual(getPrevNext("/a/", tree).next, { label: "B", href: "/b/" });
});
