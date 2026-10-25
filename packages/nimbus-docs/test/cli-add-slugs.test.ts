// `add` takes several slugs and checks every one before installing any, so a
// typo never leaves the site with half of what was asked for.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX, CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("add with an unknown slug among several installs nothing and names it", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nimbus-add-slugs-"));
  try {
    const result = run(cwd, ["add", "accordion", "not-a-component"]);
    assert.equal(result.status, 1);
    const out = result.stdout + result.stderr;
    assert.match(out, /Unknown registry item: `not-a-component`/);
    assert.match(out, /Nothing was installed/);
    assert.deepEqual(readdirSync(cwd), [], "no file was written");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("add with two unknown slugs names both", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nimbus-add-slugs-"));
  try {
    const result = run(cwd, ["add", "nope-one", "nope-two"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /Unknown registry items: `nope-one`, `nope-two`/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
