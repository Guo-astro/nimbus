// nimbus-docs.com's /changelog/ source: package CHANGELOG.md files dated by
// release tags.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { orderReleases, parseChangelog, parseTagDates } from "../src/lib/releases.ts";

test("each ## <version> is a release; code blocks hold no headings, whatever their fences", () => {
  const markdown = [
    "# @cloudflare/nimbus-docs",
    "",
    "## 1.1.0",
    "",
    "### Minor Changes",
    "",
    "- Outer",
    "  - Nested [#1](https://example.test/1)",
    "",
    "````md",
    "```",
    "## 9.9.9",
    "```",
    "````",
    "",
    "~~~",
    "## 8.8.8",
    "~~~~",
    "",
    "## 1.0.0",
    "",
    "### Patch Changes",
    "",
    "- Fix",
  ].join("\n");
  const releases = parseChangelog("nimbus-docs", markdown);
  assert.deepEqual(releases.map((r) => r.version), ["1.1.0", "1.0.0"]);
  assert.equal(
    releases[0]!.body,
    ["## Minor Changes", "", "- Outer", "  - Nested [#1](https://example.test/1)", "", "````md", "```", "## 9.9.9", "```", "````", "", "~~~", "## 8.8.8", "~~~~"].join("\n"),
  );
  assert.equal(releases[1]!.body, "## Patch Changes\n\n- Fix");
});

test("fences inside lists and quotes don't cut or swallow releases", () => {
  for (const block of ["- ```js\n  example()\n  ```", "> ```\n> ## 7.7.7\n> ```"]) {
    const releases = parseChangelog("nimbus-docs", `## 1.1.0\n\n${block}\n\n## 1.0.0\n\nOld release.\n`);
    assert.deepEqual(releases.map((r) => [r.version, r.body]), [["1.1.0", block], ["1.0.0", "Old release."]]);
  }
});

test("the real changelogs parse: every version heading, with 0.18.1's links kept", async () => {
  for (const pkg of ["nimbus-docs", "create-nimbus-docs"] as const) {
    const markdown = await readFile(new URL(`../../../packages/${pkg}/CHANGELOG.md`, import.meta.url), "utf8");
    const releases = parseChangelog(pkg, markdown);
    assert.equal(releases.length, markdown.match(/^## /gm)!.length);
    if (pkg === "nimbus-docs") {
      const latest = releases.find((r) => r.version === "0.18.1")!;
      assert.match(latest.body, /^## Patch Changes\n/);
      assert.match(latest.body, /\[#247\]\(https:\/\/github\.com\/cloudflare\/nimbus\/pull\/247\)/);
    }
  }
});

const parsed = [
  ...parseChangelog("nimbus-docs", "## 0.2.0\n\nb\n\n## 0.1.0\n\na\n\n## 0.0.1\n\nunreleased"),
  ...parseChangelog("create-nimbus-docs", "## 0.10.0\n\nd\n\n## 0.9.0\n\nc"),
];

test("tagged releases, newest first; same moment: nimbus-docs first, then higher version; untagged left out", () => {
  const tags = parseTagDates(
    [
      "@cloudflare/nimbus-docs@0.2.0 2026-02-01T10:00:00+00:00",
      "@cloudflare/create-nimbus-docs@0.10.0 2026-02-01T10:00:00+00:00",
      "@cloudflare/create-nimbus-docs@0.9.0 2026-02-01T10:00:00+00:00",
      "@cloudflare/nimbus-docs@0.1.0 2026-01-01T09:00:00+01:00",
      "templates-v0.9.0 2026-02-01T10:00:00+00:00",
    ].join("\n"),
  );
  const releases = orderReleases(parsed, tags);
  assert.deepEqual(
    releases.map((r) => [r.title, r.id, r.date?.toISOString()]),
    [
      ["nimbus-docs 0.2.0", "nimbus-docs-0-2-0", "2026-02-01T10:00:00.000Z"],
      ["create-nimbus-docs 0.10.0", "create-nimbus-docs-0-10-0", "2026-02-01T10:00:00.000Z"],
      ["create-nimbus-docs 0.9.0", "create-nimbus-docs-0-9-0", "2026-02-01T10:00:00.000Z"],
      ["nimbus-docs 0.1.0", "nimbus-docs-0-1-0", "2026-01-01T08:00:00.000Z"],
    ],
  );
});

test("without tags, every version is listed undated, in file order, nimbus-docs first", () => {
  const releases = orderReleases(parsed, new Map());
  assert.deepEqual(
    releases.map((r) => [r.title, r.date]),
    [
      ["nimbus-docs 0.2.0", undefined],
      ["nimbus-docs 0.1.0", undefined],
      ["nimbus-docs 0.0.1", undefined],
      ["create-nimbus-docs 0.10.0", undefined],
      ["create-nimbus-docs 0.9.0", undefined],
    ],
  );
});
