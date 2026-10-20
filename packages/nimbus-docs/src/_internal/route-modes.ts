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
import { isRequiredCanonicalRouteComponent } from "./route-ownership.js";

export type AstroOutput = "static" | "server";

// Astro's own reading of a route's mode (`core/routing/prerender.js`).
const PRERENDER = /^\s*export\s+const\s+prerender\s*=\s*(true|false);?/m;

/** A route file's own mode, by Astro's rule: its `prerender` line, else the `output` default. */
export function fileRouteMode(source: string, output: AstroOutput): RenderingMode {
  const match = PRERENDER.exec(source);
  if (match) return match[1] === "true" ? "build" : "request";
  return output === "server" ? "request" : "build";
}

/** Whether Astro warns that a request-rendered route's `getStaticPaths()` is ignored: its substring test. */
export function warnsIgnoredStaticPaths(file: string, source: string): boolean {
  return /\.(?:astro|js|ts)$/u.test(file) && source.includes("getStaticPaths");
}

/** A route Astro can build only from `getStaticPaths`: one with a `[param]` or `[...spread]` segment. */
export function isDynamicRoute(file: string): boolean {
  return /\[[^\]]+\]/u.test(file.replaceAll("\\", "/"));
}

export interface RouteFileMismatch {
  /**
   * `mode`: `rendering` overrides the file's mode. `ignored-paths`: it renders
   * on request with `getStaticPaths`. `missing-paths`: it builds a dynamic
   * route with no `getStaticPaths`, which Astro can't do.
   */
  kind: "mode" | "ignored-paths" | "missing-paths";
  fileMode: RenderingMode;
  mode: RenderingMode;
}

/**
 * How a managed route file disagrees with the mode `rendering` gives it.
 * `overridden` is whether the build applies that mode over the file's own,
 * which it does only when `rendering` is set.
 */
export function routeFileMismatch(input: {
  file: string;
  source: string;
  output: AstroOutput;
  expected: RenderingMode;
  overridden: boolean;
}): RouteFileMismatch | null {
  const fileMode = fileRouteMode(input.source, input.output);
  const mode = input.overridden ? input.expected : fileMode;
  if (mode === "build" && isDynamicRoute(input.file) && !input.source.includes("getStaticPaths"))
    return { kind: "missing-paths", fileMode, mode };
  if (fileMode !== mode) return { kind: "mode", fileMode, mode };
  if (mode === "request" && warnsIgnoredStaticPaths(input.file, input.source))
    return { kind: "ignored-paths", fileMode, mode };
  return null;
}

/** What's wrong with a file, for the build's warning and `check`; `subject` is its collection, or "it". */
export function describeRouteFileMismatch(mismatch: RouteFileMismatch, subject: string): string {
  const when = (mode: RenderingMode) => (mode === "build" ? "ahead of time" : "on request");
  const verb = (mode: RenderingMode) => (mode === "build" ? "builds" : "renders");
  if (mismatch.kind === "missing-paths")
    return `\`rendering\` builds ${subject} ahead of time, but the file has no getStaticPaths`;
  if (mismatch.kind === "ignored-paths") return "file renders on request, so Astro ignores its getStaticPaths";
  return (
    `file ${verb(mismatch.fileMode)} ${when(mismatch.fileMode)}, ` +
    `\`rendering\` ${verb(mismatch.mode)} ${subject} ${when(mismatch.mode)}`
  );
}

/**
 * The collections `rendering` can name before content sync: `docs`, version
 * and API collections, and every key in `rendering.collections`, each with a
 * route at its URL.
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
  ]);
  return [...candidates].filter((collection) => {
    const component = canonicalCollectionRouteComponent(input.srcDir, collection, input.mountContext, input.projectRoot);
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
  for (const [collection, mode] of Object.entries(policy.collections)) {
    const mount = collectionMountPrefix(collection, mountContext);
    if (mount && mount !== "/") mountModes.set(mount, mode);
  }
  return {
    rootMode: policy.collections[PRIMARY_COLLECTION] ?? policy.default,
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
  return collection === undefined ? "it" : collection === PRIMARY_COLLECTION ? "docs" : `"${collection}"`;
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
