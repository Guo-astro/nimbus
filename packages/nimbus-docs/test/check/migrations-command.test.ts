import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runningNimbusVersion } from "../../src/_internal/upgrades.js";
import { checkMigrations } from "../../src/check/migrations.js";

test("check suggests migrate the way the project runs the CLI, not a raw Node path", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-check-migrate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ devDependencies: { "@cloudflare/nimbus-docs": runningNimbusVersion() } }),
  );
  fs.mkdirSync(path.join(dir, "node_modules", "@cloudflare", "nimbus-docs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", "@cloudflare", "nimbus-docs", "package.json"),
    JSON.stringify({ name: "@cloudflare/nimbus-docs", version: runningNimbusVersion() }),
  );

  const report = checkMigrations(dir);
  const baseline = report.findings.find((finding) => finding.code === "nimbus/upgrade-baseline");
  assert.ok(baseline, JSON.stringify(report.findings));
  assert.match(baseline.message, /Run `pnpm nimbus-docs migrate --from <version>`\./);
  assert.ok(!baseline.message.includes(process.execPath), baseline.message);
});

// A preview's version is the registry's guess at the next release, so the
// note can't name the base release; it says which one to use, and when.
test("on a preview, the baseline note says which release to pass, not a guessed version", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-check-preview-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { "@cloudflare/nimbus-docs": "https://pkg.pr.new/@cloudflare/nimbus-docs@178" } }),
  );
  fs.writeFileSync(
    path.join(dir, "nimbus.json"),
    JSON.stringify({ lastReviewedNimbusVersion: null, preview: { pr: "178", templates: "bundled" } }),
  );

  const note = checkMigrations(dir).notes.find((n) => n.code === "nimbus/upgrade-baseline-missing");
  assert.ok(note);
  assert.match(note.reason, /Once you install a release, run `.*migrate --from <version>` with the last release the site used before the preview/);
});
