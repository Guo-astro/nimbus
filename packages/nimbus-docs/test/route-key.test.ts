import assert from "node:assert/strict";
import { test } from "node:test";

import { linkRouteKey, routeKey } from "../src/_internal/route-key.js";

test("routeKey maps output files and page pathnames to one shape", () => {
  const cases: Array<[string, string]> = [
    ["", "/"],
    ["/", "/"],
    ["index.html", "/"],
    ["foo/index.html", "/foo"],
    ["foo.html", "/foo"],
    ["/foo/", "/foo"],
    ["cli", "/cli"],
    ["llms.txt", "/llms.txt"],
    ["welcome/index.md", "/welcome/index.md"],
    ["files/doc.pdf", "/files/doc.pdf"],
    ["docs/x/index.html", "/docs/x"],
    // Already-decoded names are not decoded again.
    ["guides/100%25.txt", "/guides/100%25.txt"],
  ];
  for (const [input, expected] of cases) assert.equal(routeKey(input), expected, input);
});

test("linkRouteKey drops query and hash, decodes, and never strips a base", () => {
  const cases: Array<[string, string]> = [
    ["/foo/?a=1#b", "/foo"],
    ["/foo#b", "/foo"],
    ["/guides/setup%20notes", "/guides/setup notes"],
    ["/foo/index.html", "/foo"],
    ["/docs/getting-started", "/docs/getting-started"],
    ["/", "/"],
    ["/%E0%A4%A", "/%E0%A4%A"],
  ];
  for (const [input, expected] of cases) assert.equal(linkRouteKey(input), expected, input);
});
