/**
 * Bring a project's route files in step with `rendering`, read build-free
 * the way `check` reads the config. Used by `check --fix`, `add adapter-*`,
 * the scaffolder and starter diffs.
 */

import fs from "node:fs";
import path from "node:path";

import type { RenderingConfig } from "../types.js";
import { PRIMARY_COLLECTION, type MountContext } from "./collection-mount.js";
import { decideCollectionMounts, findCollectionRoutes } from "./collection-routes.js";
import { resolveMigrationSrcDir } from "./migrations.js";
import { parseAstroConfigFields, parseNimbusConfig } from "./parse-nimbus-config.js";
import { setRouteFileMode, type RouteFileEdit, type RouteFileTarget } from "./route-file-mode.js";
import {
  describeRouteFileMismatch,
  managedRouteFiles,
  renderingCollections,
  routeFileMismatch,
  routeFileSubject,
  type AstroOutput,
  type RouteFileMismatch,
} from "./route-modes.js";
import { compileRenderingPolicy, movedCollectionRoute } from "./rendering-policy.js";

export interface RouteFilePlan {
  /** Project-relative, `/`-separated. */
  file: string;
  mismatch: RouteFileMismatch;
  /** One line on what's wrong. */
  problem: string;
  /** The edit to the mode `rendering` gives it. */
  edit: RouteFileEdit;
  /** The edit changes the file: a full one, or the part a manual edit could make. */
  writes: boolean;
}

export type RouteFilesPlan = { ok: true; configured: boolean; files: RouteFilePlan[] } | { ok: false; reason: string };

export interface ProjectRouteFile {
  /** Project-relative, `/`-separated. */
  file: string;
  source: string;
  /** The mode `rendering` gives it; `page` is set for a collection's page route. */
  target: RouteFileTarget;
  subject: string;
}

export type ProjectRouteFiles =
  | { ok: true; configured: boolean; files: ProjectRouteFile[] }
  | { ok: false; reason: string };

/** Every managed route file in a project, with the mode `rendering` gives it. */
export function projectRouteFiles(cwd: string, srcDirOverride?: string): ProjectRouteFiles {
  const parsed = parseNimbusConfig(cwd);
  if (!parsed.ok) return { ok: false, reason: "the Nimbus config can't be read statically" };
  if (parsed.unresolved.includes("rendering") || parsed.unresolved.includes("...spread"))
    return { ok: false, reason: "the `rendering` config isn't a plain literal" };
  const fields = parseAstroConfigFields(cwd);
  if (!fields || fields.unresolved.includes("output") || fields.unresolved.includes("...spread"))
    return { ok: false, reason: "Astro's `output` isn't a plain literal" };
  const output: AstroOutput = fields.output === "server" ? "server" : "static";
  const srcDir = resolveMigrationSrcDir(cwd, srcDirOverride).srcDir ?? path.join(cwd, "src");

  const config = parsed.config as { versions?: { others?: unknown }; api?: unknown; rendering?: RenderingConfig };
  const versions = Array.isArray(config.versions?.others)
    ? config.versions.others.filter((name): name is string => typeof name === "string")
    : [];
  const apiCollections = Array.isArray(config.api)
    ? config.api.flatMap((entry: { collection?: unknown }) => (typeof entry?.collection === "string" ? [entry.collection] : []))
    : [];
  const versionInfo = config.versions ? { others: versions } : null;
  const { mounts } = decideCollectionMounts(findCollectionRoutes(srcDir, cwd).found, versionInfo, apiCollections);
  const mountContext: MountContext = { versions: versionInfo, routes: mounts };
  let policy: ReturnType<typeof compileRenderingPolicy>;
  try {
    policy = compileRenderingPolicy(
      config.rendering,
      renderingCollections({ rendering: config.rendering, versions, apiCollections, srcDir, projectRoot: cwd, mountContext }),
    );
  } catch {
    return { ok: false, reason: "the `rendering` config names a collection with no route" };
  }

  const files = managedRouteFiles({ srcDir, projectRoot: cwd, policy, mountContext }).map((managed): ProjectRouteFile => {
    const collection = managed.kind === "page" ? managed.collection : undefined;
    const page: RouteFileTarget["page"] = collection === undefined
      ? undefined
      : {
          collection,
          kind: collection === PRIMARY_COLLECTION ? "docs" : apiCollections.includes(collection) ? "api" : "collection",
          moved: movedCollectionRoute(collection, mountContext) !== undefined,
        };
    return {
      file: path.relative(cwd, managed.file).split(path.sep).join("/"),
      source: managed.source,
      target: { mode: managed.mode, output, page },
      subject: routeFileSubject(collection),
    };
  });
  return { ok: true, configured: config.rendering !== undefined, files };
}

/** Every managed route file that doesn't match `rendering`, with its edit. */
export function planRouteFiles(cwd: string, srcDirOverride?: string): RouteFilesPlan {
  const project = projectRouteFiles(cwd, srcDirOverride);
  if (!project.ok) return project;
  const files: RouteFilePlan[] = [];
  for (const { file, source, target, subject } of project.files) {
    const mismatch = routeFileMismatch({ file, source, output: target.output, expected: target.mode });
    if (!mismatch) continue;
    const edit = setRouteFileMode(file, source, target);
    files.push({
      file,
      mismatch,
      problem: describeRouteFileMismatch(mismatch, subject, project.configured),
      edit,
      writes: edit.status !== "unchanged" && edit.source !== source,
    });
  }
  return { ok: true, configured: project.configured, files };
}

/** Write every edit the helper could make, including part of a manual one; the rest is left for the author. */
export function applyRouteFiles(cwd: string, plan: RouteFilePlan[]): { updated: string[]; manual: RouteFilePlan[] } {
  const updated: string[] = [];
  const manual: RouteFilePlan[] = [];
  for (const entry of plan) {
    if (entry.writes && entry.edit.status !== "unchanged") {
      fs.writeFileSync(path.join(cwd, entry.file), entry.edit.source);
      updated.push(entry.file);
    }
    if (entry.edit.status === "manual") manual.push(entry);
  }
  return { updated, manual };
}

/** Plan and write in one step: what the scaffolder and `add adapter-*` run after setting `rendering`. */
export function alignRouteFiles(cwd: string): {
  updated: string[];
  manual: Array<{ file: string; todo: string }>;
  /** Whether the site sets `rendering`; `undefined` when Nimbus couldn't read the config. */
  configured?: boolean;
  skipped?: string;
} {
  const plan = planRouteFiles(cwd);
  if (!plan.ok) return { updated: [], manual: [], skipped: plan.reason };
  const { updated, manual } = applyRouteFiles(cwd, plan.files);
  return {
    configured: plan.configured,
    updated,
    manual: manual.map((entry) => ({ file: entry.file, todo: entry.edit.status === "manual" ? entry.edit.todo : "" })),
  };
}
