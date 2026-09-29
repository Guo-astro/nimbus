import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

function initForce(nimbusJson: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-cli-init-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), `{ "name": "site" }`);
  fs.writeFileSync(path.join(root, "nimbus.json"), nimbusJson);
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "init", "--force"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const written = JSON.parse(fs.readFileSync(path.join(root, "nimbus.json"), "utf8")) as { lastReviewedNimbusVersion: unknown };
  fs.rmSync(root, { recursive: true, force: true });
  return { status: result.status, output: result.stdout + result.stderr, written };
}

test("init --force keeps the reviewed upgrade baseline", () => {
  const { status, output, written } = initForce(`{ "lastReviewedNimbusVersion": "0.15.0" }\n`);
  assert.equal(status, 0, output);
  assert.equal(written.lastReviewedNimbusVersion, "0.15.0");
});

test("init --force records no baseline when the old file has none or doesn't parse", () => {
  assert.equal(initForce(`{ "lastReviewedNimbusVersion": "not-a-version" }\n`).written.lastReviewedNimbusVersion, null);
  assert.equal(initForce(`{ broken`).written.lastReviewedNimbusVersion, null);
});
