/**
 * Resolves an authored root-relative link against `.nimbus/routes.json`:
 * known routes, the platform's redirect rules, and Astro's redirect pages.
 * Shared by `internal-link` and `redirected-link` so they agree.
 *
 * Redirect chains are followed whatever each hop's status, up to the browser
 * limit; status only decides `redirectedTo`. Sources match the path as
 * written (never its route key), per the platform's rules (`matchRedirect`).
 * Route keys are base-free; redirect lines are served paths, so `base` is
 * stripped from them.
 */

import { matchesAnyIgnore } from "../_internal/ignore-glob.js";
import { linkRouteKey } from "../_internal/route-key.js";
import type { NormalizedRedirect } from "../_internal/redirect-emitters.js";

export const MAX_REDIRECT_HOPS = 20;

const PERMANENT = new Set([301, 308]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);

interface CompiledRule {
  index: number;
  to: string;
  status: number;
  force: boolean;
}

interface PatternRule extends CompiledRule {
  re: RegExp;
  names: string[];
}

export interface LinkEnv {
  knownRoutes: ReadonlySet<string>;
  opaqueNamespaces: readonly string[];
  /** `/docs`, or `""` when unset. */
  base: string;
  rules: "cloudflare" | "netlify";
  /** Astro's meta-refresh pages, by route key of their source. */
  redirectPages: ReadonlyMap<string, { to: string; status: number }>;
  exact: Map<string, CompiledRule>;
  patterns: PatternRule[];
}

/** `offBase`: a served path outside `base`, which no root-relative link can express. */
export interface RedirectedTo {
  url: string;
  offBase: boolean;
}

export type Resolution =
  | { kind: "valid"; redirectedTo?: RedirectedTo }
  | {
      kind: "broken";
      reason: string;
      throughRedirect: boolean;
      /** The link's spelling with the trailing slash flipped, when that matches a rule. */
      slashHint?: string;
    };

/** Raw option values: the glob matcher caches on their identity. */
export interface ResolveOptions {
  ignore?: unknown;
}

export function createLinkEnv(input: {
  knownRoutes: Iterable<string>;
  base: string;
  redirects: readonly NormalizedRedirect[];
  redirectPages?: readonly NormalizedRedirect[];
  redirectRules?: "cloudflare" | "netlify";
  opaqueNamespaces?: readonly string[];
}): LinkEnv {
  const baseKey = linkRouteKey(input.base || "/");
  const base = baseKey === "/" ? "" : baseKey;
  const exact = new Map<string, CompiledRule>();
  const patterns: PatternRule[] = [];
  const redirectPages = new Map<string, { to: string; status: number }>();
  for (const page of input.redirectPages ?? []) {
    const from = stripBase(page.from.split(/[?#]/)[0]!, base);
    const key = from === null ? null : linkRouteKey(from);
    if (key !== null && !redirectPages.has(key)) {
      redirectPages.set(key, { to: page.to, status: page.status });
    }
  }
  input.redirects.forEach((r, index) => {
    if (r.status !== 200 && !REDIRECT.has(r.status)) return;
    const from = stripBase(r.from.split(/[?#]/)[0]!, base);
    if (from === null) return;
    const isPattern = from.includes("*") || /(^|\/):[A-Za-z]/.test(from);
    if (!isPattern) {
      const identity = sourceIdentity(from);
      const rule = { index, to: r.to, status: r.status, force: r.force === true };
      if (!exact.has(identity)) exact.set(identity, rule);
      return;
    }
    if (r.status === 200) return;
    const compiled = compilePattern(from);
    if (compiled) {
      patterns.push({ index, to: r.to, status: r.status, force: r.force === true, ...compiled });
    }
  });
  return {
    knownRoutes: new Set(input.knownRoutes),
    opaqueNamespaces: input.opaqueNamespaces ?? [],
    base,
    rules: input.redirectRules ?? "cloudflare",
    redirectPages,
    exact,
    patterns,
  };
}

export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

export function resolveLink(env: LinkEnv, startPath: string, opts: ResolveOptions): Resolution {
  let path = startPath;
  let key = linkRouteKey(path);
  let hops = 0;
  let permanentRun = true;
  let redirectedTo: RedirectedTo | undefined;
  const chain: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    // The caller checks the link itself against `ignore`.
    if (chain.length > 0 && matchesAnyIgnore(key, opts.ignore)) {
      return { kind: "valid", redirectedTo };
    }
    const match = matchRedirect(env, pathnameOf(path), key);
    if (match) {
      if (match.status === 200) return { kind: "valid", redirectedTo };
      if (seen.has(match.matched)) {
        return {
          kind: "broken",
          reason: `redirect loop: ${[startPath, ...chain].join(" → ")}.`,
          throughRedirect: true,
        };
      }
      seen.add(match.matched);
      hops++;
      if (hops > MAX_REDIRECT_HOPS) {
        return {
          kind: "broken",
          reason: `more than ${MAX_REDIRECT_HOPS} redirects, which browsers stop following.`,
          throughRedirect: true,
        };
      }
      // Platforms pass the query through; a meta-refresh page doesn't.
      const destination = match.page
        ? match.destination
        : withIncomingQuery(match.destination, path);
      chain.push(destination);
      if (permanentRun && PERMANENT.has(match.status)) {
        redirectedTo = authoredUrl(destination, env.base);
      } else {
        permanentRun = false;
      }
      if (isExternalUrl(destination)) return { kind: "valid", redirectedTo };
      const next = stripBase(destination.split("#")[0]!, env.base);
      if (next === null) return { kind: "valid", redirectedTo };
      path = next;
      key = linkRouteKey(path);
      continue;
    }
    if (env.knownRoutes.has(key)) return { kind: "valid", redirectedTo };
    if (chain.length === 0) {
      const pathname = pathnameOf(path);
      const toggled = pathname.endsWith("/") ? pathname.slice(0, -1) : `${pathname}/`;
      // Only Cloudflare's exact matching can miss by a slash.
      const slashHint =
        env.rules === "cloudflare" && toggled !== "" && matchPath(env, toggled, false)
          ? `${toggled}${queryOf(path)}`
          : undefined;
      return {
        kind: "broken",
        reason: "no page resolves to this path.",
        throughRedirect: false,
        ...(slashHint ? { slashHint } : {}),
      };
    }
    const last = chain[chain.length - 1]!;
    return {
      kind: "broken",
      reason:
        chain.length === 1
          ? `redirects to "${last}", which no page resolves to.`
          : `redirects through ${chain.map((c) => `"${c}"`).join(" → ")}, and no page resolves to the last one.`,
      throughRedirect: true,
    };
  }
}

/**
 * The next hop for `pathname` (encoded, trailing slash kept), or null.
 *   - Cloudflare: rules match exactly and apply even over a file.
 *   - Netlify: rules ignore the trailing slash; over a file, only forced
 *     (`!`) rules apply and the file is served.
 * When no rule applies, Astro's redirect page at the path, if any.
 */
function matchRedirect(
  env: LinkEnv,
  pathname: string,
  key: string,
): { destination: string; status: number; matched: string; page: boolean } | null {
  const rule =
    env.rules === "cloudflare"
      ? matchPath(env, pathname, false)
      : matchNetlify(env, pathname, env.knownRoutes.has(key));
  if (rule) return { destination: rule.destination, status: rule.status, matched: rule.matched, page: false };
  const page = env.redirectPages.get(key);
  return page ? { destination: page.to, status: page.status, matched: `page:${key}`, page: true } : null;
}

function matchNetlify(
  env: LinkEnv,
  pathname: string,
  forcedOnly: boolean,
): { destination: string; status: number; matched: string } | null {
  const toggled = pathname.endsWith("/") ? pathname.slice(0, -1) : `${pathname}/`;
  const a = matchPath(env, pathname, forcedOnly);
  const b = toggled === "" ? null : matchPath(env, toggled, forcedOnly);
  const best = a && b ? (a.index <= b.index ? a : b) : (a ?? b);
  return best ? { ...best, matched: linkRouteKey(pathname) } : null;
}

function matchPath(
  env: LinkEnv,
  pathname: string,
  forcedOnly: boolean,
): { index: number; destination: string; status: number; matched: string } | null {
  const exactRule = env.exact.get(sourceIdentity(pathname));
  const exact = exactRule && (!forcedOnly || exactRule.force) ? exactRule : undefined;
  let best: { index: number; destination: string; status: number } | null = exact
    ? { index: exact.index, destination: exact.to, status: exact.status }
    : null;
  for (const rule of env.patterns) {
    if (best && rule.index > best.index) break;
    if (forcedOnly && !rule.force) continue;
    const m = rule.re.exec(pathname);
    if (!m) continue;
    // Captures stay encoded: `%23` must not become `#`.
    let destination = rule.to;
    rule.names.forEach((name, i) => {
      destination = destination.split(`:${name}`).join(m[i + 1] ?? "");
    });
    best = { index: rule.index, destination, status: rule.status };
    break;
  }
  return best ? { ...best, matched: pathname } : null;
}

/** `*` binds `:splat` (a trailing `/*` also matches the bare prefix); `:name` matches one segment. */
function compilePattern(from: string): { re: RegExp; names: string[] } | null {
  if ((from.match(/\*/g) ?? []).length > 1) return null;
  const names: string[] = [];
  let tail = "";
  let body = from;
  if (body.endsWith("/*")) {
    body = body.slice(0, -2);
    tail = "(?:/(.*))?";
  }
  let source = "";
  for (const segment of body.split("/").slice(1)) {
    if (/^:[A-Za-z]\w*$/.test(segment)) {
      names.push(segment.slice(1));
      source += "/([^/]+)";
    } else if (segment.includes("*")) {
      names.push("splat");
      source += `/${escape(segment).replace("\\*", "(.*)")}`;
    } else {
      source += `/${escape(segment)}`;
    }
  }
  if (tail !== "") names.push("splat");
  return { re: new RegExp(`^${source}${tail}$`), names };
}

function pathnameOf(path: string): string {
  return path.split(/[?#]/)[0]! || "/";
}

function sourceIdentity(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** A destination as an author writes it: without `base`, which the renderer adds. */
function authoredUrl(destination: string, base: string): RedirectedTo {
  if (isExternalUrl(destination)) return { url: destination, offBase: false };
  const authored = stripBase(destination, base);
  return authored === null
    ? { url: destination, offBase: true }
    : { url: authored, offBase: false };
}

function withIncomingQuery(destination: string, path: string): string {
  const [beforeHash, hash] = splitHash(destination);
  if (beforeHash.includes("?")) return destination;
  const query = queryOf(path);
  return query ? `${beforeHash}${query}${hash}` : destination;
}

function queryOf(path: string): string {
  const withoutHash = path.split("#")[0]!;
  const i = withoutHash.indexOf("?");
  return i === -1 ? "" : withoutHash.slice(i);
}

function splitHash(url: string): [string, string] {
  const i = url.indexOf("#");
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Null when outside `base`. Compares the pathname only: `/docs?x` is inside `/docs`. */
function stripBase(path: string, base: string): string | null {
  if (base === "") return path;
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  const suffix = cut === -1 ? "" : path.slice(cut);
  if (pathname === base || pathname === `${base}/`) return `/${suffix}`;
  return pathname.startsWith(`${base}/`) ? `${pathname.slice(base.length)}${suffix}` : null;
}

// The same link appears on many pages; `ignore` is the same array for a run.
const NONE = {};
const memo = new WeakMap<LinkEnv, WeakMap<object, Map<string, Resolution>>>();

export function resolveLinkCached(env: LinkEnv, url: string, opts: ResolveOptions): Resolution {
  const byIgnore = memo.get(env) ?? memo.set(env, new WeakMap()).get(env)!;
  const ignoreKey = isObject(opts.ignore) ? opts.ignore : NONE;
  const byUrl = byIgnore.get(ignoreKey) ?? byIgnore.set(ignoreKey, new Map()).get(ignoreKey)!;
  let resolution = byUrl.get(url);
  if (!resolution) {
    resolution = resolveLink(env, url, opts);
    byUrl.set(url, resolution);
  }
  return resolution;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
