/**
 * `lint` and `check` read the site base the renderer uses: from
 * `.nimbus/lint.json`, else `.nimbus/routes.json`, else none, with a note.
 * Drives the real `lint` CLI and `checkAuthoring`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { checkAuthoring } from "../../src/check/authoring.js";
import { ROUTE_TRUTH_VERSION } from "../../src/lint/site-model.js";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const UNKNOWN = /Couldn't read the site base \(run `astro sync`\); image paths were checked as if the site had none\./;
const STALE = /config changed since \.nimbus\/lint\.json was written/;
const SKIPS = 'image "/arch.png" skips the site base "/docs" and won\'t load. Write "/docs/arch.png".';

interface Project {
  /** `null` writes no lint.json; `undefined` base leaves the key out. */
  lint?: { base?: string; markdownFeatures?: boolean; rules?: Record<string, unknown> } | null;
  routesBase?: string;
  astroBase?: string;
}

function project(spec: Project): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-site-base-"));
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  };
  write("src/content/docs/page.mdx", "---\ntitle: Page\n---\n\n![Arch](/arch.png)\n");
  write("public/arch.png", "x");
  if (spec.lint !== null) {
    const lint = spec.lint ?? {};
    write(
      ".nimbus/lint.json",
      JSON.stringify({
        version: 1,
        rules: lint.rules ?? { "nimbus/image-ref": "error" },
        collections: {},
        site: "https://example.test",
        ...(lint.markdownFeatures ? { markdownFeatures: {} } : {}),
        ...(lint.base !== undefined ? { base: lint.base } : {}),
      }),
    );
  }
  if (spec.routesBase !== undefined) {
    write(
      ".nimbus/routes.json",
      JSON.stringify({
        version: ROUTE_TRUTH_VERSION,
        base: spec.routesBase,
        knownRoutes: ["/"],
        redirects: [],
        redirectPages: [],
        redirectRules: "cloudflare",
        opaqueNamespaces: [],
      }),
    );
  }
  if (spec.astroBase !== undefined) {
    write(
      "astro.config.ts",
      [
        'import { defineConfig } from "astro/config";',
        'import nimbus from "@cloudflare/nimbus-docs";',
        `export default defineConfig({ base: ${JSON.stringify(spec.astroBase)}, integrations: [nimbus({ title: "Docs" }, { rules: { "nimbus/image-ref": "error" } })] });`,
      ].join("\n"),
    );
  }
  return dir;
}

function lint(spec: Project, args: string[] = []) {
  const dir = project(spec);
  try {
    const res = spawnSync(process.execPath, ["--import", TSX, CLI, "lint", "--format", "json", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
    const json = JSON.parse(res.stdout) as { diagnostics: Array<{ code: string; message: string }> };
    return { stderr: res.stderr, messages: json.diagnostics.filter((d) => d.code === "nimbus/image-ref").map((d) => d.message) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function check(spec: Project) {
  const dir = project(spec);
  try {
    const report = checkAuthoring(dir);
    return {
      notes: report.notes.map((n) => n.code),
      messages: report.findings.filter((f) => f.code === "nimbus/image-ref").map((f) => f.message),
      stale: report.findings.some((f) => f.code === "nimbus/lint-config-stale"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("lint and check read the base from lint.json and report the same finding", () => {
  const spec = { lint: { base: "/docs" } };
  const fromLint = lint(spec);
  assert.deepEqual(fromLint.messages, [SKIPS]);
  assert.doesNotMatch(fromLint.stderr, UNKNOWN);
  const fromCheck = check(spec);
  assert.deepEqual(fromCheck.messages, fromLint.messages);
  assert.ok(!fromCheck.notes.includes("nimbus/site-base-unknown"));
});

test("a lint.json without base falls back to routes.json, normalised", () => {
  for (const lintJson of [{}, { markdownFeatures: true }]) {
    const res = lint({ lint: lintJson, routesBase: "/docs/" });
    assert.deepEqual(res.messages, [SKIPS]);
    assert.doesNotMatch(res.stderr, UNKNOWN);
    assert.match(res.stderr, /older build without the site base[\s\S]*\.nimbus\/routes\.json[\s\S]*astro sync/);
    const fromCheck = check({ lint: lintJson, routesBase: "/docs/" });
    assert.deepEqual(fromCheck.messages, [SKIPS]);
    assert.ok(fromCheck.notes.includes("nimbus/site-base-from-routes"));
    assert.ok(!fromCheck.notes.includes("nimbus/site-base-unknown"));
  }
  assert.ok(!check({ lint: { base: "/docs" }, routesBase: "/docs/" }).notes.includes("nimbus/site-base-from-routes"));
});

test("with no base anywhere, lint and check say they checked without one", () => {
  for (const spec of [{ lint: {} }, { lint: { markdownFeatures: true } }]) {
    const res = lint(spec);
    assert.deepEqual(res.messages, []);
    assert.match(res.stderr, UNKNOWN);
    assert.ok(check(spec).notes.includes("nimbus/site-base-unknown"));
  }
  assert.match(lint({ lint: null }, ["--rule", "nimbus/image-ref"]).stderr, UNKNOWN);
});

test("no note at the root or when image-ref is off", () => {
  assert.doesNotMatch(lint({ lint: { base: "" } }).stderr, UNKNOWN);
  assert.doesNotMatch(lint({ lint: { rules: { "nimbus/single-h1": "warn" } } }).stderr, UNKNOWN);
  assert.ok(!check({ lint: { rules: { "nimbus/single-h1": "warn" } } }).notes.includes("nimbus/site-base-unknown"));
});

test("a changed literal base marks lint.json stale; other spellings of the same base don't", () => {
  assert.match(lint({ lint: { base: "/docs" }, astroBase: "/guide" }).stderr, STALE);
  assert.ok(check({ lint: { base: "/docs" }, astroBase: "/guide" }).stale);
  for (const astroBase of ["/docs/", "docs", "/docs"]) {
    assert.doesNotMatch(lint({ lint: { base: "/docs" }, astroBase }).stderr, STALE, astroBase);
  }
});
