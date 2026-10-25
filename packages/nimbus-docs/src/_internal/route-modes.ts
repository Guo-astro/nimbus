/**
 * How each route file Nimbus manages should render under `rendering`, and
 * whether the file says so itself. Shared by the build, `check` and the CLI
 * edits, so they read the same files the same way.
 */

import fs from "node:fs";
import path from "node:path";

import type { RenderingConfig, RenderingMode } from "../types.js";
import { collectionMountPrefix, PRIMARY_COLLECTION, type MountContext } from "./collection-mount.js";
import { sharedMarkdownRouteSurface } from "./markdown-routes-plugin.js";
import { canonicalCollectionRouteComponent, type CompiledRenderingPolicy } from "./rendering-policy.js";
import { readRouteFileExports, type RouteExports } from "./route-exports.js";
import { isRequiredCanonicalRouteComponent } from "./route-ownership.js";

export type AstroOutput = "static" | "server";

/**
 * A route file's own mode, by Astro's rule: its `prerender` export, else the
 * `output` default. `undefined` when `prerender` is set by an expression or
 * exported from a list.
 */
export function fileRouteMode(exports: RouteExports, output: AstroOutput): RenderingMode | undefined {
  if (exports.listedPrerender) return undefined;
  if (exports.prerenders.length === 0) return output === "server" ? "request" : "build";
  const [only] = exports.prerenders;
  if (exports.prerenders.length > 1 || only!.value === undefined) return undefined;
  return only!.value ? "build" : "request";
}

/** A route Astro can build only from `getStaticPaths`: one with a `[param]` or `[...spread]` segment. */
export function isDynamicRoute(file: string): boolean {
  return /\[[^\]]+\]/u.test(file.replaceAll("\\", "/"));
}

export interface RouteFileMismatch {
  /**
   * `mode`: the file's mode differs from the one Nimbus gives it.
   * `ignored-paths`: it renders on request with `getStaticPaths`.
   * `missing-paths`: it builds a dynamic route with no `getStaticPaths`,
   * which Astro can't do.
   * `expression`: it sets `prerender` with an expression, which the mode
   * Nimbus gives it overrides.
   * `listed`: it exports `prerender` from a list, which Astro doesn't read.
   */
  kind: "mode" | "ignored-paths" | "missing-paths" | "expression" | "listed";
  /** `undefined` when its `prerender` is an expression or listed. */
  fileMode?: RenderingMode;
  mode: RenderingMode;
}

/**
 * How a managed route file disagrees with the mode `rendering` gives it,
 * which the build applies over the file's own. Without `rendering`, that's
 * `"build"`, as for `rendering: { default: "build" }`.
 */
export function routeFileMismatch(input: {
  file: string;
  source: string;
  output: AstroOutput;
  expected: RenderingMode;
}): RouteFileMismatch | null {
  const exports = readRouteFileExports(input.file, input.source);
  const fileMode = fileRouteMode(exports, input.output);
  const base = { ...(fileMode ? { fileMode } : {}), mode: input.expected };
  if (input.expected === "build" && isDynamicRoute(input.file) && !exports.staticPaths) return { kind: "missing-paths", ...base };
  // Two `prerender` exports don't compile, so the build reports those itself.
  if (exports.listedPrerender) return { kind: "listed", ...base };
  if (fileMode === undefined) return exports.prerenders.length === 1 ? { kind: "expression", ...base } : null;
  if (fileMode !== input.expected) return { kind: "mode", ...base };
  if (input.expected === "request" && exports.staticPaths) return { kind: "ignored-paths", ...base };
  return null;
}

/**
 * What's wrong with a file, for the build's warning and `check`; `subject` is
 * its collection, or "it". `configured` is whether the site sets `rendering`.
 */
export function describeRouteFileMismatch(mismatch: RouteFileMismatch, subject: string, configured: boolean): string {
  const policy = configured ? "`rendering`" : "Nimbus";
  const when = (mode: RenderingMode) => (mode === "build" ? "ahead of time" : "on request");
  const verb = (mode: RenderingMode) => (mode === "build" ? "builds" : "renders");
  if (mismatch.kind === "missing-paths") return `${policy} builds ${subject} ahead of time, but the file has no getStaticPaths`;
  if (mismatch.kind === "ignored-paths") return "file renders on request, so Astro ignores its getStaticPaths";
  if (mismatch.kind === "expression")
    return `file sets \`prerender\` with an expression, but ${policy} ${verb(mismatch.mode)} ${subject} ${when(mismatch.mode)} whatever it says`;
  if (mismatch.kind === "listed")
    return `file exports \`prerender\` from a list, but Astro reads only \`export const prerender = true;\` or \`false\`, and ${policy} ${verb(mismatch.mode)} ${subject} ${when(mismatch.mode)}`;
  const fileMode = mismatch.fileMode!;
  return `file ${verb(fileMode)} ${when(fileMode)}, ${policy} ${verb(mismatch.mode)} ${subject} ${when(mismatch.mode)}`;
}

/** Said once with route-file problems on a site without `rendering`. */
export const DEFAULT_RENDERING_NOTE =
  "With no `rendering` set, Nimbus builds every route it manages ahead of time; set `rendering` to render some on request.";

/**
 * The collections `rendering` can name before content sync: `docs`, version
 * and API collections, and every key in `rendering.collections`, each with a
 * route at its URL. Without `rendering`, also every collection a route file
 * names, so Nimbus builds them all.
 */
export function renderingCollections(input: {
  rendering: RenderingConfig | undefined;
  versions: readonly string[];
  apiCollections: readonly string[];
  srcDir: string;
  projectRoot: string;
  mountContext: MountContext;
}): string[] {
  const candidates = new Set([
    PRIMARY_COLLECTION,
    ...input.versions.map((version) => `${PRIMARY_COLLECTION}-${version}`),
    ...input.apiCollections,
    ...Object.keys(input.rendering?.collections ?? {}),
    ...(input.rendering === undefined ? input.mountContext.routes.keys() : []),
  ]);
  // A route file that serves one collection isn't another's default route: an
  // API served from `src/pages/[...slug].astro` leaves no `docs` route there.
  const claimed = new Map<string, string>();
  for (const [collection, { file }] of input.mountContext.routes) {
    if (file) claimed.set(path.join(input.projectRoot, file), collection);
  }
  return [...candidates].filter((collection) => {
    const component = canonicalCollectionRouteComponent(input.srcDir, collection, input.mountContext, input.projectRoot);
    if ((claimed.get(component) ?? collection) !== collection) return false;
    return (
      (input.rendering !== undefined && isRequiredCanonicalRouteComponent(input.projectRoot, input.srcDir, component)) ||
      fs.existsSync(component)
    );
  });
}

/** The modes agent route files take: the root collection's, the default, and each mount's. */
export interface AgentRendering {
  rootMode: RenderingMode;
  defaultMode: RenderingMode;
  mountModes: Map<string, RenderingMode>;
}

export function agentRendering(policy: CompiledRenderingPolicy, mountContext: MountContext): AgentRendering {
  const mountModes = new Map<string, RenderingMode>();
  let rootMode = policy.collections[PRIMARY_COLLECTION];
  for (const [collection, mode] of Object.entries(policy.collections)) {
    const mount = collectionMountPrefix(collection, mountContext);
    if (mount && mount !== "/") mountModes.set(mount, mode);
    else rootMode ??= mode;
  }
  return {
    rootMode: rootMode ?? policy.default,
    defaultMode: policy.default,
    mountModes,
  };
}

/**
 * The mode for an agent route file at `relative` (to `src/pages`), or
 * `undefined` when it isn't one: wrong shape, an unknown mount, or no Nimbus
 * agent factory call. The root routes (`[...slug]/index.md.ts`,
 * `[...slug]/index.mdx.ts`, `[section]/llms.txt.ts`) take the root
 * collection's mode; the site-wide `llms.txt.ts` and `llms-full.txt.ts` take
 * the default; `<mount>/…` takes the mount's.
 */
export function agentRouteModeAt(relative: string, source: string, policy: AgentRendering): RenderingMode | undefined {
  const parts = relative.replaceAll("\\", "/").split("/");
  const file = parts.at(-1) ?? "";
  const isMarkdownFile = /^index\.mdx?\.[cm]?[jt]s$/u.test(file);
  const isLlmsFile = /^llms(?:-full)?\.txt\.[cm]?[jt]s$/u.test(file);
  if (!isMarkdownFile && !isLlmsFile) return undefined;
  // The parameter name is the author's choice; only the shape matters.
  const isSpread = (segment: string) => /^\[\.\.\..+\]$/u.test(segment);
  const isParam = (segment: string) => /^\[.+\]$/u.test(segment);
  const folders = parts.slice(0, -1);
  const mountMode = (mount: string[]) =>
    mount.some(isParam) ? undefined : policy.mountModes.get(`/${mount.join("/")}`);
  let mode: RenderingMode | undefined;
  if (folders.length === 0 && isLlmsFile) {
    mode = policy.defaultMode;
  } else if (isMarkdownFile && folders.length > 0 && isSpread(folders.at(-1)!)) {
    mode = folders.length === 1 ? policy.rootMode : mountMode(folders.slice(0, -1));
  } else if (file.startsWith("llms.txt.") && folders.length > 0) {
    mode = folders.length === 1 && isParam(folders[0]!) ? policy.rootMode : mountMode(folders);
  }
  return mode && sharedMarkdownRouteSurface(source) ? mode : undefined;
}

interface RouteFileBase {
  /** Absolute path. */
  file: string;
  /** The mode `rendering` gives it. */
  mode: RenderingMode;
  source: string;
}

export type ManagedRouteFile = (RouteFileBase & { kind: "page"; collection: string }) | (RouteFileBase & { kind: "agent" });

/** How a route file's problem names what it serves: `docs`, `"sdk"`, or `it` for an agent route. */
export function routeFileSubject(collection: string | undefined): string {
  return collection === undefined ? "it" : `"${collection}"`;
}

/**
 * Every project route file whose mode `rendering` decides: each collection's
 * page route, and the agent route files at the root and at mounts. Alias
 * routes, routes under dynamic folders, the homepage and other routes keep
 * their own mode.
 */
export function managedRouteFiles(input: {
  srcDir: string;
  projectRoot: string;
  policy: CompiledRenderingPolicy;
  mountContext: MountContext;
}): ManagedRouteFile[] {
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const out: ManagedRouteFile[] = [];
  for (const [collection, mode] of Object.entries(input.policy.collections)) {
    const file = canonicalCollectionRouteComponent(input.srcDir, collection, input.mountContext, input.projectRoot);
    const source = read(file);
    if (source !== undefined) out.push({ kind: "page", file, mode, collection, source });
  }
  const agents = agentRendering(input.policy, input.mountContext);
  const pagesDir = path.join(input.srcDir, "pages");
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^(?:index\.mdx?|llms(?:-full)?\.txt)\.[cm]?[jt]s$/u.test(entry.name)) {
        const source = read(full);
        const mode = source === undefined ? undefined : agentRouteModeAt(path.relative(pagesDir, full), source, agents);
        if (mode) out.push({ kind: "agent", file: full, mode, source: source! });
      }
    }
  };
  walk(pagesDir);
  return out;
}
