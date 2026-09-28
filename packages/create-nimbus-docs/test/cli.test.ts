import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  engines: { node: string };
};
// Build-time constants the bundler inlines into the CLI.
const DEFINES = `data:text/javascript,globalThis.__MIN_NODE_VERSION__=${JSON.stringify(PKG.engines.node.replace(/^>=/, ""))};globalThis.__APP_VERSION__=${JSON.stringify(PKG.version)};`;

function scaffoldWithoutTerminal(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "nimbus-create-cli-"));
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--import", DEFINES, fileURLToPath(new URL("../src/index.ts", import.meta.url)), ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
  );
  return { cwd, output: result.stdout + result.stderr, status: result.status };
}

test("without a terminal, the first prompt asks for --yes or flags instead of crashing", () => {
  const { cwd, output, status } = scaffoldWithoutTerminal(["site"]);
  try {
    assert.equal(status, 1, output);
    assert.match(output, /No terminal to ask "Starter content\?" Pass --content starter\|empty to answer it, or --yes/);
    assert.equal(existsSync(join(cwd, "site")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("without a terminal, flags that answer every prompt need no --yes", () => {
  const { cwd, output } = scaffoldWithoutTerminal([
    "site",
    "--content", "empty",
    "--package-manager", "npm",
    "--git",
    "--deploy", "other",
    "--skip-install",
    "--template-dir", "missing-templates",
  ]);
  try {
    assert.doesNotMatch(output, /No terminal/);
    assert.match(output, /missing-templates/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
