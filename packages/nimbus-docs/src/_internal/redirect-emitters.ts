// Platform redirect emitter — static lane only. With an adapter installed, the
// adapter already emits platform redirects from `astroConfig.redirects`; on a
// static build Astro only writes meta-refresh HTML, so a `_redirects` file
// upgrades those to real edge 301s. Vercel is excluded: its static deploys read
// a *committed* `vercel.json` before the build, which a build artifact can't be.

import fs from "node:fs";
import path from "node:path";

export type RedirectConfigLike =
  | string
  | { status: number; destination: string };

export interface NormalizedRedirect {
  from: string;
  to: string;
  status: number;
  force?: boolean;
}

export interface DeploySignals {
  cloudflare: boolean;
  netlify: boolean;
}

export function detectDeploySignals(projectRoot: string): DeploySignals {
  const has = (name: string) => fs.existsSync(path.join(projectRoot, name));
  return {
    cloudflare:
      has("wrangler.jsonc") || has("wrangler.json") || has("wrangler.toml"),
    netlify: has("netlify.toml"),
  };
}

export function shouldEmitRedirects(signals: DeploySignals): boolean {
  return signals.cloudflare || signals.netlify;
}

// Astro's default status for the bare-string redirect form.
const DEFAULT_STATUS = 301;

function isExternal(routePath: string): boolean {
  return /^https?:\/\//.test(routePath) || routePath.startsWith("//");
}

function withBase(base: string, routePath: string): string {
  const clean =
    base && base !== "/" ? `/${base.replace(/^\/+|\/+$/g, "")}` : "";
  return `${clean}${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
}

function isDynamic(routePath: string): boolean {
  return routePath.includes("[") || routePath.includes("]");
}

export interface NormalizeResult {
  redirects: NormalizedRedirect[];
  skipped: string[];
}

// Dynamic patterns are dropped rather than mis-translated to platform syntax;
// self-redirects are dropped to avoid loops.
export function normalizeRedirects(
  redirects: Record<string, RedirectConfigLike>,
  base: string,
): NormalizeResult {
  const out: NormalizedRedirect[] = [];
  const skipped: string[] = [];
  for (const [from, config] of Object.entries(redirects)) {
    const to = typeof config === "string" ? config : config.destination;
    const status = typeof config === "string" ? DEFAULT_STATUS : config.status;
    if (isDynamic(from) || isDynamic(to)) {
      skipped.push(from);
      continue;
    }
    const fromWithBase = withBase(base, from);
    const toWithBase = isExternal(to) ? to : withBase(base, to);
    if (fromWithBase === toWithBase) continue;
    out.push({ from: fromWithBase, to: toWithBase, status });
  }
  return { redirects: out, skipped };
}

// Existing content is kept verbatim and existing sources win, so re-running over
// a user's `public/_redirects` (or our own prior output) is idempotent.
export function formatRedirectsFile(
  existing: string | null,
  redirects: readonly NormalizedRedirect[],
): string {
  const existingSources = new Set<string>();
  const existingLines: string[] = [];
  if (existing) {
    for (const line of existing.split("\n")) {
      existingLines.push(line);
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const source = trimmed.split(/\s+/)[0];
      if (source) existingSources.add(source);
    }
    while (existingLines.length > 0 && existingLines.at(-1)!.trim() === "") {
      existingLines.pop();
    }
  }

  const appended = redirects
    .filter((r) => !existingSources.has(r.from))
    .map((r) => `${r.from} ${r.to} ${r.status}`);

  const lines = [...existingLines, ...appended];
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
