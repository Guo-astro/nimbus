#!/usr/bin/env node
/**
 * Scaffold, install, build and `check` every template variant with one
 * non-pnpm package manager, so a failure only one of them hits (Yarn 2+'s
 * Plug'n'Play, bun's install layout) fails a PR instead of a new user.
 * `templates-check.mjs` covers pnpm and the output lanes.
 *
 * Usage: TEMPLATES_PM=npm|yarn|bun node scripts/templates-pm-check.mjs
 *
 * Yarn scaffolds as if `yarn@4` (through corepack) ran the scaffolder, then
 * runs as plain `corepack yarn`, so the site's own `packageManager` pin picks
 * the version. bun must be on PATH.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTemplates } from "../packages/create-nimbus-docs/scripts/copy-template.mjs";
import { spawnCommandSync } from "./child-process.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = resolve(ROOT, ".generated", "templates");
const SCAFFOLDER_BIN = resolve(ROOT, "packages", "create-nimbus-docs", "dist", "index.js");
const NIMBUS_NAME = JSON.parse(readFileSync(resolve(ROOT, "packages", "nimbus-docs", "package.json"), "utf8")).name;

const COMMANDS = {
  // `exec` runs the site's installed bin and never falls back to the registry,
  // whose unscoped `nimbus-docs` is an unrelated package.
  npm: { bin: "npm", prefix: [], run: ["run"], exec: ["exec", "--no", "--"] },
  yarn: { bin: "corepack", prefix: ["yarn"], run: ["run"], exec: ["run"] },
  bun: { bin: "bun", prefix: [], run: ["run"], exec: ["run"] },
};
const PM = process.env.TEMPLATES_PM;
const pm = COMMANDS[PM];
if (!pm) fail(`TEMPLATES_PM must be one of ${Object.keys(COMMANDS).join(", ")}; received ${PM}`);

const cleanup = [];
process.on("exit", () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function fail(message) {
  console.error(`\n[templates-pm-check] FAIL — ${message}`);
  process.exit(1);
}

function run(bin, args, cwd = ROOT, env = {}) {
  const result = spawnCommandSync(bin, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    // Yarn turns on immutable installs under CI, which a fresh site without
    // a lockfile can't satisfy; a user's first install isn't immutable either.
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", YARN_ENABLE_IMMUTABLE_INSTALLS: "false", ...env },
  });
  if (result.status !== 0) fail(`\`${bin} ${args.join(" ")}\` failed in ${cwd} (exit ${result.status ?? result.signal})`);
}

function runPm(site, ...args) {
  run(pm.bin, [...pm.prefix, ...args], site);
}

// Every fresh site still has the placeholder `site` URL for its owner to set.
const EXPECTED_ON_A_FRESH_SITE = new Set(["nimbus/site-placeholder"]);

function assertCleanCheck(site, content) {
  // Exit 1 means errors; list them rather than stopping at the status.
  const { stdout } = spawnCommandSync(pm.bin, [...pm.prefix, ...pm.exec, "nimbus-docs", "check", "--json"], {
    cwd: site,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  let report;
  try {
    report = JSON.parse(stdout.slice(stdout.indexOf("{")));
  } catch {
    fail(`the ${content} site's check printed no JSON report:\n${stdout}`);
  }
  const unexpected = report.findings.filter((finding) => finding.severity === "error" || !EXPECTED_ON_A_FRESH_SITE.has(finding.code));
  if (unexpected.length > 0) {
    fail(`the ${content} site's first check isn't clean:\n${unexpected.map((f) => `  ${f.code}: ${f.message}`).join("\n")}`);
  }
}

run("pnpm", ["--filter", "./packages/nimbus-docs", "--filter", "./packages/create-nimbus-docs", "build"]);
generateTemplates(GENERATED);

// Scaffolds resolve the in-repo framework, not whatever is on npm.
const packDest = mkdtempSync(join(tmpdir(), "nimbus-docs-pack-"));
cleanup.push(packDest);
run("pnpm", ["--filter", "./packages/nimbus-docs", "exec", "pnpm", "pack", "--pack-destination", packDest]);
const tgz = readdirSync(packDest).find((file) => file.endsWith(".tgz"));
if (!tgz) fail(`no ${NIMBUS_NAME} tarball in ${packDest}`);
const tarball = join(packDest, tgz);

// The user agent the scaffolder sees when a package manager runs it. Asked
// outside the repo, whose own `packageManager` makes corepack refuse Yarn.
function userAgent() {
  if (PM !== "yarn") return "";
  const { status, stdout } = spawnCommandSync("corepack", ["yarn@4", "--version"], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  const version = stdout?.trim();
  if (status !== 0 || !version) fail("`corepack yarn@4 --version` failed");
  return `yarn/${version}`;
}
const USER_AGENT = userAgent();

for (const content of ["starter", "empty"]) {
  const work = mkdtempSync(join(tmpdir(), `nimbus-templates-${PM}-`));
  cleanup.push(work);
  // The scaffolder's own install would fetch the published framework, so
  // install after pointing the site at the tarball.
  run(
    "node",
    [SCAFFOLDER_BIN, "site", "--yes", "--skip-install", "--no-git", "--package-manager", PM, "--content", content, "--template-dir", GENERATED],
    work,
    { npm_config_user_agent: USER_AGENT },
  );
  const site = join(work, "site");
  const pkgPath = join(site, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.dependencies?.[NIMBUS_NAME]) fail(`the ${content} site declares no ${NIMBUS_NAME} dependency`);
  if (PM === "yarn" && !/^yarn@[2-9]/.test(pkg.packageManager ?? "")) {
    fail(`the ${content} site doesn't pin Yarn 2+ (packageManager: ${pkg.packageManager}), so corepack would run Yarn 1`);
  }
  pkg.dependencies[NIMBUS_NAME] = `file:${tarball}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  runPm(site, "install");
  runPm(site, ...pm.run, "typecheck");
  runPm(site, ...pm.run, "build");
  assertCleanCheck(site, content);
  console.log(`[templates-pm-check] ok — ${PM} scaffolds, installs, builds and checks the ${content} variant`);
}

console.log(`\n[templates-pm-check] OK — ${PM}`);
