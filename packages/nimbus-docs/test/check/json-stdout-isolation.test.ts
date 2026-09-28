import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const SENTINEL = "FAKE-PM-STDOUT-SENTINEL";

// The agent-facing --json contract: nothing but the JSON payload may reach
// stdout. A --fix install shells out to the package manager, whose stdout must
// not corrupt the stream. Drive the real CLI with a fake pnpm that pollutes
// stdout and assert the payload still parses.
test("check --json --fix --yes: installer stdout never corrupts the JSON payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-json-iso-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });

  const fakePnpm = path.join(bin, "pnpm");
  fs.writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node\nprocess.stdout.write("${SENTINEL}\\n");\nprocess.exit(0);\n`,
  );
  fs.chmodSync(fakePnpm, 0o755);

  // pnpm-lock.yaml forces pnpm detection; search-on + no pagefind → a fixable
  // install finding, which is what triggers the shell-out under test.
  fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture" }`);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import nimbus from "@cloudflare/nimbus-docs";\nexport default { integrations: [nimbus({ site: "https://docs.example.com", title: "X" })] };`,
  );

  try {
    const res = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "check", "--json", "--fix", "--yes"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );

    assert.ok(!res.stdout.includes(SENTINEL), "installer stdout leaked into the payload");
    let parsed: { ok: boolean; status: string; readiness: string };
    assert.doesNotThrow(() => {
      parsed = JSON.parse(res.stdout);
    }, `stdout is not valid JSON:\n${res.stdout}`);
    assert.equal(typeof parsed!.status, "string");
    assert.equal(typeof parsed!.readiness, "string");
    // The fix was attempted (fake pnpm ran) but pagefind is still unresolvable.
    assert.equal(res.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check --fix without a terminal asks for --yes when only installs remain", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-fix-remedy-"));
  fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "fixture" }`);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import nimbus from "@cloudflare/nimbus-docs";\nexport default { integrations: [nimbus({ site: "https://docs.example.com", title: "X" })] };`,
  );
  try {
    const res = spawnSync(process.execPath, ["--import", TSX, CLI, "check", "--env", "--fix"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(res.stdout, /run `pnpm dlx @cloudflare\/nimbus-docs check --fix --yes`/, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /in a terminal/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
