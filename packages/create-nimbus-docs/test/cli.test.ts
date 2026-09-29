import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  engines: { node: string };
  preferUnplugged?: boolean;
};
// Build-time constants the bundler inlines into the CLI.
const DEFINES = `data:text/javascript,globalThis.__MIN_NODE_VERSION__=${JSON.stringify(PKG.engines.node.replace(/^>=/, ""))};globalThis.__APP_VERSION__=${JSON.stringify(PKG.version)};`;

function scaffoldWithoutTerminal(args: string[], env: NodeJS.ProcessEnv = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "nimbus-create-cli-"));
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--import", DEFINES, fileURLToPath(new URL("../src/index.ts", import.meta.url)), ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", ...env } },
  );
  return { cwd, output: result.stdout + result.stderr, status: result.status };
}

/** A minimal template plus a fake `npm` on PATH that exits with `npmExit`. */
function withTemplateAndNpm(npmExit: number, run: (args: string[], env: NodeJS.ProcessEnv) => void) {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-create-tmpl-"));
  const template = join(dir, "template");
  const bin = join(dir, "bin");
  mkdirSync(template);
  mkdirSync(bin);
  writeFileSync(join(template, "package.json"), `{ "name": "template", "version": "0.0.0" }`);
  writeFileSync(join(template, "astro.config.ts"), `export default {\n  // nimbus:adapter\n};\n`);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm progress" >&2\necho "npm error ENOTFOUND registry" >&2\nexit ${npmExit}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  try {
    run(
      ["site", "--yes", "--no-git", "--package-manager", "npm", "--template-dir", template],
      { PATH: `${bin}:${process.env.PATH}` },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a failed install exits 1, keeps the project, and says how to finish", () => {
  withTemplateAndNpm(1, (args, env) => {
    const { cwd, output, status } = scaffoldWithoutTerminal(args, env);
    try {
      assert.equal(status, 1, output);
      assert.equal(existsSync(join(cwd, "site", "package.json")), true);
      assert.match(output, /npm error ENOTFOUND registry/);
      assert.match(output, /Created the project in site, but installing dependencies failed/);
      assert.match(output, /cd site\n.*npm install\n.*npm run dev/s);
      assert.doesNotMatch(output, /Done\. Next steps/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("after a successful install, next steps skip the install and hide its output", () => {
  withTemplateAndNpm(0, (args, env) => {
    const { cwd, output, status } = scaffoldWithoutTerminal(args, env);
    try {
      assert.equal(status, 0, output);
      assert.doesNotMatch(output, /npm progress/);
      assert.match(output, /cd site\n {4}npm run dev/);
      assert.doesNotMatch(output, /npm install/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("without a terminal, every unanswered question and its flag is named in one error", () => {
  const { cwd, output, status } = scaffoldWithoutTerminal(["site"]);
  try {
    assert.equal(status, 1, output);
    assert.match(output, /No terminal to ask these questions\. Answer with flags, or pass --yes to accept the defaults:/);
    for (const flag of ["--content starter|empty", "--package-manager npm|pnpm|yarn|bun", "--git or --no-git", "--deploy cloudflare|other (static) or --adapter cloudflare (server)"]) {
      assert.ok(output.includes(`Pass ${flag}.`), `${flag}\n${output}`);
    }
    assert.doesNotMatch(output, /a directory argument/);
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

test("unknown --content and --package-manager values are rejected before scaffolding", () => {
  for (const [flag, value, expected] of [
    ["--content", "Starter", /Unknown content "Starter"\. Expected one of: starter, empty\./],
    ["--package-manager", "pnmp", /Unknown package manager "pnmp"\. Expected one of: npm, pnpm, yarn, bun\./],
  ] as const) {
    const { cwd, output, status } = scaffoldWithoutTerminal(["site", "--yes", "--skip-install", flag, value]);
    try {
      assert.equal(status, 1, output);
      assert.match(output, expected);
      assert.equal(existsSync(join(cwd, "site")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("without a terminal, the output-mode question names both answers", () => {
  const { cwd, output } = scaffoldWithoutTerminal(["site", "--content", "empty", "--package-manager", "npm", "--no-git"]);
  try {
    assert.match(output, /Pass --deploy cloudflare\|other \(static\) or --adapter cloudflare \(server\)\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unknown and contradictory flags are rejected before scaffolding", () => {
  for (const [args, expected] of [
    [["site", "--yes", "--output", "server"], /Unknown flag --output\. Valid flags: .*--adapter.*--no-git/],
    [["site", "--yes", "--skip-instal"], /Unknown flag --skip-instal\./],
    [["site", "-yq"], /Unknown flag -yq\./],
    [["site", "--yes", "--git", "--no-git"], /--git and --no-git contradict each other/],
    [["site", "--yes", "--git=true", "--no-git"], /--git and --no-git contradict each other/],
    [["site", "-y", "--no-yes"], /--yes and --no-yes contradict each other/],
    [["site", "extra", "--yes"], /Unexpected argument "extra"\. Pass one directory, then flags\./],
    [["site", "--yes", "--deploy", "cloudflare", "--adapter", "node"], /--deploy and --adapter can't be combined/],
  ] as const) {
    const { cwd, output, status } = scaffoldWithoutTerminal([...args]);
    try {
      assert.equal(status, 1, output);
      assert.match(output, expected);
      assert.equal(existsSync(join(cwd, "site")), false, output);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("a leading -- (as pnpm passes it through) doesn't hide the flags after it", () => {
  const { cwd, output } = scaffoldWithoutTerminal(["--", "site", "--yes", "--skip-install", "--no-git", "--template-dir", "missing-templates"]);
  try {
    assert.doesNotMatch(output, /No terminal|Unexpected argument/);
    assert.match(output, /--template-dir path not found: .*missing-templates/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a numeric directory after a boolean flag, and --git false with --no-git, scaffold normally", () => {
  for (const args of [["--yes", "2026"], ["site", "--yes", "--git", "false", "--no-git"]]) {
    const { cwd, output } = scaffoldWithoutTerminal([...args, "--skip-install", "--template-dir", "missing-templates"]);
    try {
      assert.doesNotMatch(output, /contradict|must be of type string/);
      assert.match(output, /--template-dir path not found/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

// Yarn 2+ keeps packages in zip archives, which the scaffolder can't copy a
// preview's bundled templates out of; `preferUnplugged` makes Yarn extract it.
test("the package asks Yarn to extract it, so `yarn dlx` can read bundled templates", () => {
  assert.equal(PKG.preferUnplugged, true);
});
