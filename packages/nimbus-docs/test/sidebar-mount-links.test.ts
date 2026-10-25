// A sidebar link to another collection's mount (`/api`) is valid even though
// the primary collection has no page there; a link to nothing still warns.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSidebarTree } from "../src/_internal/sidebar.js";

test("links to a known mount root don't warn; unknown roots still do", (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => void warnings.push(message));
  const entries = [{ id: "intro", data: { title: "Intro" } }] as any;
  const config = {
    items: ["intro", { label: "API", link: "/api" }, { label: "Nope", link: "/nope" }],
  } as any;
  buildSidebarTree({ docs: entries }, "docs", "/intro", config, "", new Set(["/api"]));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"\/nope"/);
});
