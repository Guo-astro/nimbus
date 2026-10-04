/** The link resolver's environment, loaded once per project root per process. */

import path from "node:path";

import { createLinkEnv, type LinkEnv } from "./link-resolver.js";
import { readRouteTruth } from "./route-truth.js";

let cached: { root: string; env: LinkEnv | null } | null = null;

/** Null when route truth is unusable; `guardRouteTruth` normally fails before rules get here. */
export function loadLinkEnv(projectRoot: string): LinkEnv | null {
  if (cached && cached.root === projectRoot) return cached.env;
  const { truth, problem } = readRouteTruth(projectRoot);
  if (problem !== undefined) {
    process.stderr.write(`nimbus/internal-link: skipped — ${problem}\n`);
  }
  const env = truth
    ? createLinkEnv({
        knownRoutes: truth.knownRoutes,
        base: truth.base,
        redirects: truth.redirects,
        redirectPages: truth.redirectPages,
        redirectRules: truth.redirectRules,
        opaqueNamespaces: truth.opaqueNamespaces,
      })
    : null;
  cached = { root: projectRoot, env };
  return env;
}

/** Find the project root from a content file by walking up to the parent of `src`. */
export function inferProjectRoot(absPath: string): string {
  // `/<root>/src/content/.../page.mdx` — strip from the *last* `/src/` so
  // a developer path that happens to contain `/src/` higher up (e.g.
  // `/Users/me/src/projects/my-docs/src/content/...`) infers `my-docs`,
  // not `/Users/me`.
  const norm = absPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/src/");
  return idx === -1 ? path.dirname(absPath) : norm.slice(0, idx);
}

// Test-only — clears the process-level cache. Real callers want one load
// per CLI run; tests want isolation between cases.
export function _resetLinkEnvCacheForTests(): void {
  cached = null;
}
