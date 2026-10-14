/**
 * Resolves an authored root-relative link against `.nimbus/routes.json`:
 * built routes, the platform's redirect rules, and Astro's redirect pages.
 * Shared by `internal-link` and `redirected-link` so they agree.
 *
 * Chains are followed whatever each hop's status, up to the browser limit;
 * status only decides `redirectedTo`. Redirect sources match the path as
 * written, never its route key. Route keys are base-free, redirect lines
 * are served paths, so `base` is stripped from them.
 */

import { matchesAnyIgnore } from "../_internal/ignore-glob.js";
import { linkRouteKey } from "../_internal/route-key.js";
import type { RouteTruth } from "./site-model.js";

const MAX_REDIRECT_HOPS = 20;
const PERMANENT = new Set([301, 308]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);

interface Rule {
  index: number;
  to: string;
  status: number;
  force: boolean;
}

interface PatternRule extends Rule {
  re: RegExp;
  names: string[];
}

export interface LinkEnv {
  knownRoutes: ReadonlySet<string>;
  opaqueNamespaces: readonly string[];
  /** `/docs`, or `""` when unset. */
  base: string;
  rules: RouteTruth["redirectRules"];
  exact: Map<string, Rule>;
  patterns: PatternRule[];
  /** Astro's meta-refresh pages, by route key of their source. */
  pages: Map<string, { to: string; status: number }>;
}

export interface RedirectedTo {
  url: string;
  /** A served path outside `base`, which no root-relative link can express. */
  offBase: boolean;
}

export type Resolution =
  | { kind: "valid"; redirectedTo?: RedirectedTo }
  | {
      kind: "broken";
      reason: string;
      throughRedirect: boolean;
      /** The link with its trailing slash flipped, when that spelling matches a rule. */
      slashHint?: string;
    };

interface Hop {
  destination: string;
  status: number;
  /** Identifies the hop for loop detection. */
  id: string;
  page: boolean;
}

export function createLinkEnv(truth: Omit<RouteTruth, "version">): LinkEnv {
  const baseKey = linkRouteKey(truth.base || "/");
  const base = baseKey === "/" ? "" : baseKey;

  const exact = new Map<string, Rule>();
  const patterns: PatternRule[] = [];
  truth.redirects.forEach((r, index) => {
    if (r.status !== 200 && !REDIRECT.has(r.status)) return;
    const from = stripBase(pathnameOf(r.from), base);
    if (from === null) return;
    const rule = { index, to: r.to, status: r.status, force: r.force === true };
    if (!isPattern(from)) {
      if (!exact.has(decode(from))) exact.set(decode(from), rule);
      return;
    }
    // A pattern rewrite (`/* /index.html 200`) would make every link valid.
    if (r.status === 200) return;
    const compiled = compilePattern(from);
    if (compiled) patterns.push({ ...rule, ...compiled });
  });

  const pages = new Map<string, { to: string; status: number }>();
  for (const page of truth.redirectPages) {
    const from = stripBase(pathnameOf(page.from), base);
    if (from !== null && !pages.has(linkRouteKey(from))) {
      pages.set(linkRouteKey(from), { to: page.to, status: page.status });
    }
  }

  return {
    knownRoutes: new Set(truth.knownRoutes),
    opaqueNamespaces: truth.opaqueNamespaces,
    base,
    rules: truth.redirectRules,
    exact,
    patterns,
    pages,
  };
}

export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

/**
 * Anything that isn't root-relative resolves against the current page:
 * `./foo`, `../foo`, and bare `foo` alike. Checked before normalization,
 * which would turn `foo` into `/foo` and match an unrelated root route.
 */
export function isRelativeUrl(url: string): boolean {
  return !url.startsWith("/");
}

export function isUnderOpaqueNamespace(env: LinkEnv, key: string): boolean {
  return env.opaqueNamespaces.some(
    (ns) => ns === "/" || key === ns || key.startsWith(`${ns}/`),
  );
}

// The same link appears on many pages; `ignore` is the same array for a run.
const NO_IGNORE = {};
const memo = new WeakMap<LinkEnv, WeakMap<object, Map<string, Resolution>>>();

/** `ignore` is the rule's raw option: the glob matcher caches on its identity. */
export function resolveLink(env: LinkEnv, url: string, ignore: unknown): Resolution {
  const byIgnore = memo.get(env) ?? memo.set(env, new WeakMap()).get(env)!;
  const ignoreKey = typeof ignore === "object" && ignore !== null ? ignore : NO_IGNORE;
  const byUrl = byIgnore.get(ignoreKey) ?? byIgnore.set(ignoreKey, new Map()).get(ignoreKey)!;
  let resolution = byUrl.get(url);
  if (!resolution) {
    resolution = follow(env, url, ignore);
    byUrl.set(url, resolution);
  }
  return resolution;
}

function follow(env: LinkEnv, link: string, ignore: unknown): Resolution {
  let path = link;
  let key = linkRouteKey(path);
  let permanentRun = true;
  let redirectedTo: RedirectedTo | undefined;
  const chain: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    // The caller checks the link itself against `ignore`.
    if (chain.length > 0 && matchesAnyIgnore(key, ignore)) return { kind: "valid", redirectedTo };

    const hop = nextHop(env, pathnameOf(path), key);
    if (!hop) break;
    if (hop.status === 200) return { kind: "valid", redirectedTo };
    if (seen.has(hop.id)) {
      return {
        kind: "broken",
        reason: `redirect loop: ${[link, ...chain].join(" → ")}.`,
        throughRedirect: true,
      };
    }
    seen.add(hop.id);
    if (seen.size > MAX_REDIRECT_HOPS) {
      return {
        kind: "broken",
        reason: `more than ${MAX_REDIRECT_HOPS} redirects, which browsers stop following.`,
        throughRedirect: true,
      };
    }

    // Platforms pass the query through; a meta-refresh page doesn't.
    const destination = hop.page ? hop.destination : withQuery(hop.destination, path);
    chain.push(destination);
    if (permanentRun && PERMANENT.has(hop.status)) {
      redirectedTo = authoredUrl(destination, env.base);
    } else {
      permanentRun = false;
    }
    if (isExternalUrl(destination)) return { kind: "valid", redirectedTo };
    const next = stripBase(destination.split("#")[0]!, env.base);
    if (next === null) return { kind: "valid", redirectedTo };
    path = next;
    key = linkRouteKey(path);
  }

  if (env.knownRoutes.has(key)) return { kind: "valid", redirectedTo };
  if (chain.length > 0) {
    return {
      kind: "broken",
      reason:
        chain.length === 1
          ? `redirects to "${chain[0]}", which no page resolves to.`
          : `redirects through ${chain.map((c) => `"${c}"`).join(" → ")}, and no page resolves to the last one.`,
      throughRedirect: true,
    };
  }
  const flipped = flipTrailingSlash(pathnameOf(path));
  const slashHint =
    env.rules === "cloudflare" && flipped !== "" && matchRule(env, flipped, false)
      ? `${flipped}${queryOf(path)}`
      : undefined;
  return {
    kind: "broken",
    reason: "no page resolves to this path.",
    throughRedirect: false,
    ...(slashHint ? { slashHint } : {}),
  };
}

/**
 * The next hop for `pathname` (encoded, trailing slash kept), or null.
 *   - Cloudflare: rules match exactly and apply even over a file.
 *   - Netlify: rules ignore the trailing slash; over a file, only forced
 *     (`!`) rules apply and the file is served.
 * When no rule applies, Astro's redirect page at the path, if any.
 */
function nextHop(env: LinkEnv, pathname: string, key: string): Hop | null {
  const rule =
    env.rules === "cloudflare"
      ? matchRule(env, pathname, false)
      : matchNetlifyRule(env, pathname, env.knownRoutes.has(key));
  if (rule) return { destination: rule.destination, status: rule.status, id: rule.id, page: false };
  const page = env.pages.get(key);
  return page ? { destination: page.to, status: page.status, id: `page:${key}`, page: true } : null;
}

function matchNetlifyRule(env: LinkEnv, pathname: string, forcedOnly: boolean) {
  const flipped = flipTrailingSlash(pathname);
  const a = matchRule(env, pathname, forcedOnly);
  const b = flipped === "" ? null : matchRule(env, flipped, forcedOnly);
  const first = a && b ? (a.index <= b.index ? a : b) : (a ?? b);
  return first ? { ...first, id: linkRouteKey(pathname) } : null;
}

/** The first rule in file order whose source matches `pathname`. */
function matchRule(env: LinkEnv, pathname: string, forcedOnly: boolean) {
  const exact = env.exact.get(decode(pathname));
  let best =
    exact && (!forcedOnly || exact.force)
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
  return best ? { ...best, id: pathname } : null;
}

function isPattern(from: string): boolean {
  return from.includes("*") || /(^|\/):[A-Za-z]/.test(from);
}

/** `*` binds `:splat` (a trailing `/*` also matches the bare prefix); `:name` matches one segment. */
function compilePattern(from: string): { re: RegExp; names: string[] } | null {
  if ((from.match(/\*/g) ?? []).length > 1) return null;
  const names: string[] = [];
  const trailingSplat = from.endsWith("/*");
  const body = trailingSplat ? from.slice(0, -2) : from;
  let source = "";
  for (const segment of body.split("/").slice(1)) {
    if (/^:[A-Za-z]\w*$/.test(segment)) {
      names.push(segment.slice(1));
      source += "/([^/]+)";
    } else if (segment.includes("*")) {
      names.push("splat");
      source += `/${escapeRegExp(segment).replace("\\*", "(.*)")}`;
    } else {
      source += `/${escapeRegExp(segment)}`;
    }
  }
  if (trailingSplat) {
    names.push("splat");
    source += "(?:/(.*))?";
  }
  return { re: new RegExp(`^${source}$`), names };
}

/** A destination as an author writes it: without `base`, which the renderer adds. */
function authoredUrl(destination: string, base: string): RedirectedTo {
  if (isExternalUrl(destination)) return { url: destination, offBase: false };
  const authored = stripBase(destination, base);
  return authored === null ? { url: destination, offBase: true } : { url: authored, offBase: false };
}

/** Null when outside `base`. Compares the pathname only: `/docs?x` is inside `/docs`. */
function stripBase(path: string, base: string): string | null {
  if (base === "") return path;
  const pathname = pathnameOf(path);
  const suffix = path.slice(pathname.length);
  if (pathname === base || pathname === `${base}/`) return `/${suffix}`;
  return pathname.startsWith(`${base}/`) ? `${pathname.slice(base.length)}${suffix}` : null;
}

function withQuery(destination: string, from: string): string {
  const hashAt = destination.indexOf("#");
  const beforeHash = hashAt === -1 ? destination : destination.slice(0, hashAt);
  const query = queryOf(from);
  if (beforeHash.includes("?") || query === "") return destination;
  return `${beforeHash}${query}${destination.slice(beforeHash.length)}`;
}

function pathnameOf(path: string): string {
  return path.split(/[?#]/)[0] || "/";
}

function queryOf(path: string): string {
  const beforeHash = path.split("#")[0]!;
  const at = beforeHash.indexOf("?");
  return at === -1 ? "" : beforeHash.slice(at);
}

function flipTrailingSlash(pathname: string): string {
  return pathname.endsWith("/") ? pathname.slice(0, -1) : `${pathname}/`;
}

function decode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
