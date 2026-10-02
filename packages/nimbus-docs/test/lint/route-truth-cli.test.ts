/**
 * `nimbus-docs lint` fails closed when a link rule is on and
 * `.nimbus/routes.json` can't be used: one `error` diagnostic on that file,
 * exit 1, whatever the configured severity. Drives the real CLI.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ROUTE_TRUTH_VERSION } from "../../src/lint/site-model.js";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

interface Project {
  rules?: Record<string, unknown>;
  collections?: Record<string, unknown>;
  /** `null` writes no file; a string is written as-is. */
  routes?: string | null;
}

interface Envelope {
  version: number;
  summary: { errors: number; warnings: number; total: number; files: number };
  diagnostics: Array<{
    code: string;
    severity: string;
    file: string;
    line: number;
    column: number;
    message: string;
  }>;
}

function lint(project: Project, args: string[] = []): { status: number | null; json: Envelope } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-route-truth-cli-"));
  try {
    fs.mkdirSync(path.join(dir, "src/content/docs"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src/content/docs/page.mdx"),
      "---\ntitle: Page\n---\n\n# Page\n\nSee [x](/nope).\n",
    );
    fs.mkdirSync(path.join(dir, ".nimbus"), { recursive: true });
    if (project.rules || project.collections) {
      fs.writeFileSync(
        path.join(dir, ".nimbus/lint.json"),
        JSON.stringify({
          version: 1,
          rules: project.rules ?? {},
          collections: project.collections ?? {},
          site: "https://example.test",
        }),
      );
    }
    if (typeof project.routes === "string") {
      fs.writeFileSync(path.join(dir, ".nimbus/routes.json"), project.routes);
    }
    const res = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "lint", "--format", "json", ...args],
      { cwd: dir, encoding: "utf8" },
    );
    let json: Envelope;
    try {
      json = JSON.parse(res.stdout) as Envelope;
    } catch {
      throw new Error(`stdout is not JSON:\n${res.stdout}\nstderr:\n${res.stderr}`);
    }
    return { status: res.status, json };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const routes = (body: Record<string, unknown>) =>
  JSON.stringify({ version: ROUTE_TRUTH_VERSION, base: "", knownRoutes: ["/"], opaqueNamespaces: [], ...body });

function assertFailsClosed(
  result: ReturnType<typeof lint>,
  message: RegExp,
): void {
  assert.equal(result.status, 1);
  assert.equal(result.json.version, 1);
  assert.deepEqual(Object.keys(result.json.summary), ["errors", "warnings", "total", "files"]);
  assert.equal(result.json.diagnostics.length, 1, JSON.stringify(result.json.diagnostics));
  const [d] = result.json.diagnostics;
  assert.equal(d!.code, "nimbus/internal-link");
  assert.equal(d!.severity, "error");
  assert.equal(d!.file, ".nimbus/routes.json");
  assert.equal(d!.line, 1);
  assert.equal(d!.column, 1);
  assert.match(d!.message, message);
}

test("missing routes.json fails closed, even when the rule is a warning", () => {
  assertFailsClosed(
    lint({ rules: { "nimbus/internal-link": "warn" }, routes: null }),
    /is missing\. Run `astro build` first/,
  );
});

test("missing routes.json fails closed when only one collection turns the rule on", () => {
  assertFailsClosed(
    lint({
      collections: { docs: { rules: { "nimbus/internal-link": "error" } } },
      routes: null,
    }),
    /is missing/,
  );
});

test("malformed routes.json fails closed", () => {
  assertFailsClosed(
    lint({ rules: { "nimbus/internal-link": "error" }, routes: "{ not json" }),
    /isn't valid JSON.*Run `astro build`/,
  );
});

test("routes.json with an unknown version fails closed", () => {
  assertFailsClosed(
    lint({ rules: { "nimbus/internal-link": "error" }, routes: routes({ version: 1 }) }),
    new RegExp(`has version 1, but this version of Nimbus reads version ${ROUTE_TRUTH_VERSION}`),
  );
});

test("routes.json left by an unfinished build fails closed", () => {
  assertFailsClosed(
    lint({ rules: { "nimbus/internal-link": "error" }, routes: JSON.stringify({ incomplete: true }) }),
    /from a build that didn't finish/,
  );
});

test("--rule nimbus/internal-link force-enables the rule, so it fails closed too", () => {
  assertFailsClosed(lint({ routes: null }, ["--rule", "nimbus/internal-link"]), /is missing/);
});

test("with link rules off, a missing routes.json is not an error", () => {
  const off = lint({ rules: { "nimbus/single-h1": "error" }, routes: null });
  assert.equal(off.status, 0);
  assert.deepEqual(off.json.diagnostics, []);

  const otherRule = lint(
    { rules: { "nimbus/internal-link": "error" }, routes: null },
    ["--rule", "nimbus/single-h1"],
  );
  assert.equal(otherRule.status, 0);
  assert.deepEqual(otherRule.json.diagnostics, []);
});

test("usable routes.json runs the rule as configured", () => {
  const result = lint({ rules: { "nimbus/internal-link": "warn" }, routes: routes({}) });
  assert.equal(result.status, 0);
  assert.equal(result.json.diagnostics.length, 1);
  assert.equal(result.json.diagnostics[0]!.severity, "warn");
  assert.match(result.json.diagnostics[0]!.message, /broken link "\/nope"/);
});
