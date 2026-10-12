#!/usr/bin/env node
/**
 * Freshness guard.
 *
 * Independent versioning + immutable tags mean a starter edit is INVISIBLE to
 * users until a `create-nimbus-docs` release re-syncs the templates branch and
 * cuts a new tag. Likewise, a `nimbus-docs` minor/major changes behavior the
 * `^`-patch float won't pick up. So this guard fails a PR when it would leave
 * users stranded on stale templates:
 *
 *   if (starter source changed) OR (a changeset bumps nimbus-docs minor+)
 *     OR (the nimbus-docs code the scaffolder bundles changed)
 *     then a changeset bumping create-nimbus-docs is REQUIRED.
 *
 * A patch-only `nimbus-docs` change is fine — the scaffold's `^` pin picks it
 * up at install time — so it does not trip the guard.
 *
 * Starter files the generator strips (registry-only components and paths,
 * dev-only paths) never reach a scaffold, so they don't trip it either.
 *
 * Determines changed files from the PR base (GITHUB_BASE_REF), and reads
 * pending `.changeset/*.md` frontmatter for bumps. Skips the bot's own
 * version-bump PR (branch `changeset-release/*`), which carries no
 * changesets by construction.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { STARTER_MANIFEST } from "../packages/nimbus-starter-source/starter.manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CHANGESET_DIR = resolve(ROOT, ".changeset");
const STARTER_PREFIX = "packages/nimbus-starter-source/";
// nimbus-docs source the scaffolder bundles at build time (tsdown noExternal):
// a change here reaches `npm create` only through a CLI release.
const BUNDLED_INTO_CLI = [
  "packages/nimbus-docs/src/adapters.ts",
  "packages/nimbus-docs/src/_internal/adapters.ts",
];

// Names from manifests, keyed by stable directory so a rename needs no edit here.
const pkgName = (dir) =>
  JSON.parse(readFileSync(resolve(ROOT, "packages", dir, "package.json"), "utf8")).name;

function git(args) {
  const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return res.status === 0 ? res.stdout : "";
}

function changedFiles() {
  const base = process.env.BASE_REF ?? process.env.GITHUB_BASE_REF;
  const ranges = base
    ? [`origin/${base}...HEAD`, `${base}...HEAD`]
    : ["HEAD~1...HEAD"];
  for (const range of ranges) {
    const out = git(["diff", "--name-only", range]);
    if (out.trim()) return out.trim().split("\n");
  }
  return [];
}

/** Parse pending changeset bumps → { pkg: "patch"|"minor"|"major" } (highest wins). */
function changesetBumps() {
  const bumps = {};
  const rank = { patch: 1, minor: 2, major: 3 };
  if (!existsSync(CHANGESET_DIR)) return bumps;
  for (const file of readdirSync(CHANGESET_DIR)) {
    if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") continue;
    const fm = readFileSync(join(CHANGESET_DIR, file), "utf8").match(/^---\s*([\s\S]*?)\s*---/);
    if (!fm) continue;
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^\s*["']?([^"':]+)["']?\s*:\s*(patch|minor|major)\s*$/);
      if (!m) continue;
      const [, pkg, bump] = [m[0], m[1].trim(), m[2]];
      if (!bumps[pkg] || rank[bump] > rank[bumps[pkg]]) bumps[pkg] = bump;
    }
  }
  return bumps;
}

/**
 * Whether a starter file reaches a scaffold. The generator strips
 * registry-only components and paths and dev-only paths, so an edit there
 * ships through `nimbus-docs add`, never through a CLI release.
 */
export function starterFileShips(file, manifest = STARTER_MANIFEST) {
  if (!file.startsWith(STARTER_PREFIX)) return false;
  const rel = file.slice(STARTER_PREFIX.length);
  const prefixes = [...(manifest.registryOnlyPaths ?? []), ...(manifest.devOnlyPaths ?? [])].map((p) =>
    p.endsWith("/") ? p : `${p}/`,
  );
  if (prefixes.some((prefix) => rel.startsWith(prefix))) return false;
  const ui = rel.match(/^src\/components\/ui\/([^/]+)\//);
  if (ui && manifest.registryOnlyComponents.includes(ui[1])) return false;
  return true;
}

/**
 * The reasons this change needs a CLI changeset, or none. Pure, so the
 * policy is testable: the script feeds it git's changed files and the
 * pending changeset bumps.
 */
export function cliChangesetReasons({
  changedFiles,
  bumps,
  manifest = STARTER_MANIFEST,
  nimbusName,
  cliName,
}) {
  if (bumps[cliName]) return [];
  const reasons = [];
  if (changedFiles.some((f) => starterFileShips(f, manifest))) {
    reasons.push("• the starter source changed (packages/nimbus-starter-source/**, files that ship in templates)");
  }
  if (changedFiles.some((f) => BUNDLED_INTO_CLI.includes(f))) {
    reasons.push(`• ${nimbusName} code the scaffolder bundles changed (${BUNDLED_INTO_CLI.join(", ")})`);
  }
  if (["minor", "major"].includes(bumps[nimbusName])) {
    reasons.push(`• a changeset bumps ${nimbusName} ${bumps[nimbusName]} (more than a patch)`);
  }
  return reasons;
}

function main() {
  const headRef = process.env.GITHUB_HEAD_REF ?? "";
  if (headRef.startsWith("changeset-release/")) {
    console.log("[freshness-guard] skipping the bot's version-bump PR.");
    return;
  }
  const nimbusName = pkgName("nimbus-docs");
  const cliName = pkgName("create-nimbus-docs");
  const reasons = cliChangesetReasons({
    changedFiles: changedFiles(),
    bumps: changesetBumps(),
    nimbusName,
    cliName,
  });
  if (reasons.length) {
    console.error(
      `[freshness-guard] FAIL — this PR needs a ${cliName} changeset.\n\n` +
        reasons.join("\n") +
        `\n\nUsers only get regenerated templates when a new ${cliName} version is\n` +
        "released and its tag is synced. Without a CLI bump, your change ships to nobody.\n\n" +
        `Fix: run \`pnpm changeset\`, select ${cliName} (patch is usually right),\n` +
        "write a summary, and commit the generated .changeset/*.md file.",
    );
    process.exit(1);
  }
  console.log("[freshness-guard] ok — templates will reach users (or no re-sync needed).");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
