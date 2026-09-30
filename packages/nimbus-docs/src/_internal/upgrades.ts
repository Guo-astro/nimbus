import fs from "node:fs";
import path from "node:path";

import { compare, eq, gt, lt, lte, major, minor, patch, prerelease, valid } from "semver";

import { CLI_PACKAGE, declaresCli, detectPackageManager, installCommand, invocation } from "../cli/pm.js";
import { getCommand } from "../lib/pkgm.js";
import rawManifest from "./upgrade-manifest.json";

declare const __APP_VERSION__: string;

export type UpgradeMode = "automatic" | "detectable-manual" | "review-required" | "optional";

export interface UpgradeEntry {
  id: string;
  introducedIn: string;
  mode: UpgradeMode;
  migrationId?: string;
  changeset?: string;
  backfill?: true;
  summary: string;
  affected: string;
  instructions: string[];
  verify: string[];
}

export interface UpgradeBaseline {
  fromVersion: string | null;
  targetVersion: string;
  source: "argument" | "nimbus-json" | "missing" | "preview";
  error?: string;
  /** The error names its own fix (install or upgrade), not `migrate`. */
  installFirst?: true;
}

interface UpgradeManifest {
  schemaVersion: 1;
  oldestSupportedVersion: string;
  entries: UpgradeEntry[];
}

export const UPGRADE_MANIFEST = rawManifest as UpgradeManifest;

export function runningNimbusVersion(): string {
  if (typeof __APP_VERSION__ !== "undefined") return __APP_VERSION__;
  const version = (JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown }).version;
  if (typeof version !== "string" || !valid(version)) {
    throw new Error("Could not determine the executing Nimbus version.");
  }
  return version;
}

export function selectUpgradeEntries(fromVersion: string, targetVersion: string): UpgradeEntry[] {
  if (!valid(fromVersion)) throw new Error(`Invalid upgrade baseline version: ${fromVersion}.`);
  if (!valid(targetVersion)) throw new Error(`Invalid installed Nimbus version: ${targetVersion}.`);
  if (isAhead(fromVersion, targetVersion)) {
    throw new Error(`Upgrade baseline ${fromVersion} is newer than installed Nimbus ${targetVersion}.`);
  }
  if (lt(fromVersion, UPGRADE_MANIFEST.oldestSupportedVersion)) {
    throw new Error(
      `Upgrade baseline ${fromVersion} predates the complete manifest. Start from Nimbus ${UPGRADE_MANIFEST.oldestSupportedVersion} or upgrade in supported stages.`,
    );
  }
  // A prerelease such as 0.16.0-pr.1.shaabc carries 0.16.0's entries. Once one
  // prerelease of 0.16.0 has been reviewed, another one has no new range; the
  // final release deliberately replays 0.16.0 in case later PRs added work.
  const fromBoundary = prereleasesOfOneRelease(fromVersion, targetVersion)
    ? withoutPrerelease(fromVersion)
    : fromVersion;
  return UPGRADE_MANIFEST.entries
    .filter((entry) => gt(entry.introducedIn, fromBoundary) && lte(entry.introducedIn, withoutPrerelease(targetVersion)))
    .sort((a, b) => compare(a.introducedIn, b.introducedIn) || a.id.localeCompare(b.id));
}

function withoutPrerelease(version: string): string {
  return `${major(version)}.${minor(version)}.${patch(version)}`;
}

function prereleasesOfOneRelease(a: string, b: string): boolean {
  return prerelease(a) !== null && prerelease(b) !== null && withoutPrerelease(a) === withoutPrerelease(b);
}

// Prereleases of one release (previews differ only by PR and commit) have no order.
function isAhead(baseline: string, installed: string): boolean {
  return !prereleasesOfOneRelease(baseline, installed) && gt(baseline, installed);
}

export function resolveUpgradeBaseline(options: {
  projectRoot: string;
  fromVersion?: string;
  targetVersion?: string;
  /**
   * The caller is the project's own installed Nimbus (the build imports it
   * from the project), so an install exists even when no `node_modules` copy
   * can be found, as under Yarn Plug'n'Play.
   */
  runningFromProject?: boolean;
}): UpgradeBaseline {
  const runningVersion = runningNimbusVersion();
  let installedVersion: string | null = null;
  try {
    installedVersion = options.targetVersion === undefined
      ? installedNimbusVersion(options.projectRoot)
      : null;
  } catch (error) {
    return {
      fromVersion: null,
      targetVersion: runningVersion,
      source: "missing",
      error: errorMessage(error),
    };
  }
  // Without an install, the running CLI's version says nothing about the
  // project's: a fresh clone run through `npx` would record the latest
  // release while the lockfile installs an older one.
  if (
    options.targetVersion === undefined &&
    !options.runningFromProject &&
    installedVersion === null &&
    dependenciesMissing(options.projectRoot)
  ) {
    return {
      fromVersion: null,
      targetVersion: runningVersion,
      source: "missing",
      installFirst: true,
      error: `${CLI_PACKAGE} is not installed in this project. Install dependencies first with \`${installCommand(options.projectRoot)}\`, then rerun.`,
    };
  }
  const targetVersion = options.targetVersion ?? installedVersion ?? runningVersion;
  if (!valid(targetVersion)) {
    return { fromVersion: null, targetVersion, source: "missing", error: `Invalid installed Nimbus version: ${targetVersion}.` };
  }
  if (installedVersion && !eq(installedVersion, runningVersion)) {
    return {
      fromVersion: null,
      targetVersion,
      source: "missing",
      installFirst: true,
      error: `The executing Nimbus CLI is ${runningVersion}, but the selected project has Nimbus ${installedVersion} installed. Run the command with the project's own CLI (for example \`${invocation("migrate", options.projectRoot)}\`), or install dependencies with \`${installCommand(options.projectRoot)}\` if the lockfile already has ${runningVersion}.`,
    };
  }
  if (options.fromVersion !== undefined) {
    const fromVersion = options.fromVersion.trim();
    if (!valid(fromVersion)) {
      return { fromVersion: null, targetVersion, source: "argument", error: `--from must be an exact semantic version, received ${options.fromVersion}.` };
    }
    if (isAhead(fromVersion, targetVersion)) {
      return { fromVersion, targetVersion, source: "argument", error: `--from ${fromVersion} is newer than installed Nimbus ${targetVersion}.` };
    }
    if (lt(fromVersion, UPGRADE_MANIFEST.oldestSupportedVersion)) {
      return {
        fromVersion,
        targetVersion,
        source: "argument",
        error: `--from ${fromVersion} predates the complete upgrade manifest. The oldest supported baseline is ${UPGRADE_MANIFEST.oldestSupportedVersion}.`,
      };
    }
    const file = path.join(options.projectRoot, "nimbus.json");
    if (fs.existsSync(file)) {
      try {
        const persisted = (JSON.parse(fs.readFileSync(file, "utf8")) as { lastReviewedNimbusVersion?: unknown })
          .lastReviewedNimbusVersion;
        if (typeof persisted === "string" && valid(persisted) && !eq(persisted, fromVersion)) {
          return {
            fromVersion,
            targetVersion,
            source: "argument",
            error: `--from ${fromVersion} does not match the recorded Nimbus baseline ${persisted}.`,
          };
        }
      } catch (error) {
        return {
          fromVersion,
          targetVersion,
          source: "argument",
          error: baselineReadError(error, options.projectRoot),
        };
      }
    }
    return { fromVersion, targetVersion, source: "argument" };
  }

  const file = path.join(options.projectRoot, "nimbus.json");
  if (!fs.existsSync(file)) return { fromVersion: null, targetVersion, source: "missing" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      lastReviewedNimbusVersion?: unknown;
      preview?: unknown;
    };
    const value = parsed.lastReviewedNimbusVersion;
    if (value === undefined || value === null || value === "") {
      return {
        fromVersion: null,
        targetVersion,
        source: parsed.preview && typeof parsed.preview === "object" && hasPreviewNimbusDependency(options.projectRoot)
          ? "preview"
          : "nimbus-json",
      };
    }
    if (typeof value !== "string" || !valid(value)) {
      return { fromVersion: null, targetVersion, source: "nimbus-json", error: "nimbus.json lastReviewedNimbusVersion must be an exact semantic version or null." };
    }
    if (isAhead(value, targetVersion)) {
      const pm = detectPackageManager(options.projectRoot);
      return {
        fromVersion: value,
        targetVersion,
        source: "nimbus-json",
        installFirst: true,
        error:
          `nimbus.json was reviewed with Nimbus ${value}, newer than installed Nimbus ${targetVersion}. ` +
          `Install dependencies with \`${installCommand(options.projectRoot)}\` if the lockfile already has ${value} (for example after pulling an upgrade), ` +
          `or upgrade with \`${getCommand(pm, "add", `${CLI_PACKAGE}@${value}`)}\`.`,
      };
    }
    if (lt(value, UPGRADE_MANIFEST.oldestSupportedVersion)) {
      return {
        fromVersion: value,
        targetVersion,
        source: "nimbus-json",
        error: `nimbus.json lastReviewedNimbusVersion ${value} predates the complete upgrade manifest. The oldest supported baseline is ${UPGRADE_MANIFEST.oldestSupportedVersion}.`,
      };
    }
    return { fromVersion: value, targetVersion, source: "nimbus-json" };
  } catch (error) {
    return { fromVersion: null, targetVersion, source: "nimbus-json", error: baselineReadError(error, options.projectRoot) };
  }
}

function baselineReadError(error: unknown, projectRoot: string): string {
  return `Could not read nimbus.json: ${errorMessage(error)}. Back up and repair the file. If its starter and registry provenance can be discarded, run \`${invocation("init --force", projectRoot)}\` from the project root to recreate it.`;
}

function hasPreviewNimbusDependency(projectRoot: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const spec = manifest.dependencies?.["@cloudflare/nimbus-docs"] ??
      manifest.devDependencies?.["@cloudflare/nimbus-docs"];
    return typeof spec === "string" && /^https:\/\/pkg\.pr\.new\/@cloudflare\/nimbus-docs@/.test(spec);
  } catch {
    return false;
  }
}

/**
 * The project declares Nimbus but hasn't installed it (a fresh clone, or a
 * scaffold with `--skip-install`). Yarn Plug'n'Play has no node_modules to
 * read, so a PnP install (a `.pnp.cjs` here or at a workspace root above)
 * never counts as missing; Nimbus doesn't support PnP, so this only keeps
 * the check from getting in its way.
 */
export function dependenciesMissing(projectRoot: string): boolean {
  if (!declaresCli(projectRoot) || hasPnpInstall(projectRoot)) return false;
  try {
    return installedNimbusVersion(projectRoot) === null;
  } catch {
    return false;
  }
}

// Yarn's project is the nearest directory with a `yarn.lock`: a workspace
// package reaches its root's `.pnp.cjs`, but a separate project (a scaffold
// has its own lockfile) never borrows an ancestor's.
function hasPnpInstall(projectRoot: string): boolean {
  for (let dir = path.resolve(projectRoot); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".pnp.cjs"))) return true;
    if (fs.existsSync(path.join(dir, "yarn.lock")) || path.dirname(dir) === dir) return false;
  }
}

export function installedNimbusVersion(projectRoot: string): string | null {
  let current = path.resolve(projectRoot);
  const filesystemRoot = path.parse(current).root;
  while (true) {
    const file = path.join(current, "node_modules", "@cloudflare", "nimbus-docs", "package.json");
    let present = false;
    try {
      fs.lstatSync(file);
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (present) {
      try {
        const version = (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown }).version;
        if (typeof version === "string" && valid(version)) return version;
        throw new Error(`Installed Nimbus package at ${file} has an invalid version.`);
      } catch (error) {
        throw new Error(`Could not read installed Nimbus package metadata at ${file}: ${errorMessage(error)}`);
      }
    }
    if (current === filesystemRoot) return null;
    current = path.dirname(current);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
