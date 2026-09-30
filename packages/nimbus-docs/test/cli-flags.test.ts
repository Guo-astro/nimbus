import assert from "node:assert/strict";
import { test } from "node:test";

import { unknownFlagError } from "../src/cli/flags.js";

test("a command refuses --cwd unless it reads it", () => {
  assert.match(unknownFlagError("outdated", ["outdated", "--cwd", "site"]) ?? "", /`outdated` doesn't take --cwd\. Run it from the project directory instead\./);
  assert.match(unknownFlagError("check", ["check", "--cwd=site", "--json"]) ?? "", /`check` doesn't take --cwd/);
  assert.equal(unknownFlagError("migrate", ["migrate", "--cwd", "site", "--yes"]), null);
});

test("every documented flag passes for its command", () => {
  const ok: Array<[string | undefined, string[]]> = [
    [undefined, []],
    ["list", ["list", "--type", "ui"]],
    ["add", ["add", "server-output", "--adapter", "cloudflare", "-y"]],
    ["add", ["add", "accordion", "--overwrite", "--print"]],
    ["check", ["check", "--fix", "--yes", "--json", "--quiet", "--no-color", "--src-dir", "docs"]],
    ["check", ["check", "--env", "--structure", "--lint", "--types", "--migrations", "--format", "json"]],
    ["lint", ["lint", "--fix", "--rule", "nimbus/single-h1", "--format", "json"]],
    ["init", ["init", "--force", "--root", "packages/docs/src"]],
    ["outdated", ["outdated", "--all", "--json", "--to", "templates-v0.7.9", "--template-dir", ".generated/templates"]],
    ["migrate", ["migrate", "--dry-run", "--diff", "--from", "0.15.0", "--print"]],
    ["diff", ["diff", "AGENT.md", "--apply", "--all", "--color"]],
    ["diff", ["diff", "--help"]],
  ];
  for (const [command, argv] of ok) assert.equal(unknownFlagError(command, argv), null, argv.join(" "));
});

test("an unknown flag gets a suggestion; flags after -- are arguments", () => {
  assert.match(unknownFlagError("check", ["check", "--jsno"]) ?? "", /Did you mean --json\?/);
  assert.match(unknownFlagError("diff", ["diff", "-y"]) ?? "", /`diff` doesn't take -y/);
  assert.equal(unknownFlagError("lint", ["lint", "--", "--anything"]), null);
  assert.equal(unknownFlagError("nonsense", ["nonsense", "--cwd", "x"]), null);
});

test("--color and --no-color pass on every command, as picocolors reads them", () => {
  for (const command of [undefined, "list", "add", "init", "outdated", "check", "lint", "migrate", "diff"]) {
    for (const flag of ["--color", "--no-color"]) {
      assert.equal(unknownFlagError(command, [...(command ? [command] : []), flag]), null, `${command} ${flag}`);
    }
  }
});
