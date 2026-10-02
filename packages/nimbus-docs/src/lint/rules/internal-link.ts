/**
 * nimbus/internal-link — internal links that don't resolve to a URL the
 * build produced. Reads route truth from `.nimbus/routes.json`, which
 * `astro build` writes from Astro's pages plus every emitted file.
 *
 * Missing route truth fails closed in `nimbus-docs lint`: when the file is
 * missing, unreadable, incomplete, or has an unknown `version`, the CLI
 * reports one `error` on `.nimbus/routes.json` and doesn't run this rule
 * (`guardRouteTruth` in `engine.ts`). `nimbus-docs check` runs the rule
 * when the file exists, and turns a missing file into a note. If the rule
 * is still reached without usable truth, it writes one line to stderr and
 * reports nothing.
 *
 * Coverage:
 *   - `link` nodes (`[text](url)`)
 *   - `linkReference` nodes (`[text][ref]` resolved against `definition`s)
 *   - MDX JSX `<a href="...">`
 *   - Extra JSX components opt-in via `components: [{ name, attr }, …]` —
 *     e.g. the starter's `<LinkCard href>`. The framework only ships the
 *     `<a>` default because the starter's component names belong to the
 *     user (rename, replace, delete at will); hardcoding them here would
 *     couple the rule to a moving target.
 *
 * Resolution:
 *   - External links (with a scheme) are skipped.
 *   - In-page anchors (`#section`) are skipped (hash validation lives in
 *     the future `nimbus/internal-link-hash` rule).
 *   - Links and routes share one key (`_internal/route-key.ts`): no query,
 *     hash, or trailing slash, percent-decoded, `foo/index.html` and
 *     `foo.html` as `/foo`.
 *   - Astro's `base` is never stripped. The renderer prefixes `base` to
 *     every authored root-relative link, so authored `/x` is compared with
 *     the base-free route `/x`, and a link that repeats the base
 *     (`/docs/x` under `base: "/docs"`) is reported: it renders as
 *     `/docs/docs/x`.
 *   - Links under an opaque namespace (a non-framework dynamic route file)
 *     stay silent — silence beats false-positive.
 *   - When the framework root catch-all is present, content entries are
 *     the truth for the root namespace.
 *   - A near-match in the route set produces a "did you mean" hint via
 *     Levenshtein distance — same pattern `component-pascalcase` uses. The
 *     hint prints the route as stored, which is how the link should be
 *     written.
 *   - `ignore: string[]` supports full glob syntax (`**`, `*`, `{a,b}`, …)
 *     via `../../_internal/ignore-glob.js` (picomatch-backed), matched
 *     against the link's route key: the authored path without trailing
 *     slash, hash, or query. Patterns are written without `base`, like
 *     links.
 *
 * Relative links (`./foo`, `../bar`, bare `foo`) error by default. `allowRelative: true`
 * silences them for projects that want to use them.
 */

import path from "node:path";

import { matchesAnyIgnore } from "../../_internal/ignore-glob.js";
import { suggest } from "../../_internal/levenshtein.js";
import { linkRouteKey } from "../../_internal/route-key.js";
import {
  collect,
  startOf,
  visit,
  type MdNode,
  type ParsedFile,
} from "../parse.js";
import { readRouteTruth } from "../route-truth.js";
import type { Rule } from "../rule.js";

interface LoadedRoutes {
  knownRoutes: Set<string>;
  opaqueNamespaces: string[];
  /** Normalized `base` (`/docs`), or `""` when unset. Only used for hints. */
  base: string;
}

// Process-level cache: read `routes.json` and build the route `Set` once
// per CLI invocation, not once per file. The rule itself is stateless; the
// cache lives in the module scope.
let cached: { root: string; routes: LoadedRoutes | null } | null = null;

function loadRoutes(file: ParsedFile): LoadedRoutes | null {
  const root = inferProjectRoot(file.absPath);
  if (cached && cached.root === root) return cached.routes;

  const { truth, problem } = readRouteTruth(root);
  if (problem !== undefined) {
    process.stderr.write(`nimbus/internal-link: skipped — ${problem}\n`);
  }
  let routes: LoadedRoutes | null = null;
  if (truth) {
    const base = linkRouteKey(truth.base);
    routes = {
      knownRoutes: new Set(truth.knownRoutes),
      opaqueNamespaces: truth.opaqueNamespaces,
      base: base === "/" ? "" : base,
    };
  }
  cached = { root, routes };
  return routes;
}

/** Find the project root from a content file by walking up to the parent of `src`. */
function inferProjectRoot(absPath: string): string {
  // `/<root>/src/content/.../page.mdx` — strip from the *last* `/src/` so
  // a developer path that happens to contain `/src/` higher up (e.g.
  // `/Users/me/src/projects/my-docs/src/content/...`) infers `my-docs`,
  // not `/Users/me`.
  const norm = absPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/src/");
  return idx === -1 ? path.dirname(absPath) : norm.slice(0, idx);
}

// ---------------------------------------------------------------------------

export const internalLink: Rule = {
  code: "nimbus/internal-link",
  run(ctx) {
    // Skip draft sources. Drafts are excluded from `routes.json` (the
    // framework filters them everywhere — content queries, sidebar,
    // version alternates), so a draft linking to another draft would
    // false-positive against the published route truth. Drafts are
    // in-flight; their links get rewritten before publishing anyway.
    // Published-page → draft links still go un-flagged, which is the
    // known trade-off vs. the route-tagged alternative.
    if (ctx.file.frontmatter?.draft === true) return;

    const routes = loadRoutes(ctx.file);
    if (!routes) return;

    const allowRelative = ctx.options.allowRelative === true;
    // Pass through raw, unfiltered — `matchesAnyIgnore` caches its
    // compiled matcher on this array's identity. Filtering here would
    // break that cache (new array per file).
    const ignore = ctx.options.ignore;
    const extraComponents = readExtraComponents(ctx.options.components);

    // Route truth is written at the end of `astro:build:done` (see
    // `materializeRouteTruth` in `integration.ts`). We just compare
    // against it.
    const { knownRoutes, opaqueNamespaces } = routes;
    const definitions = collectDefinitions(ctx.file.tree);

    for (const occ of collectLinkOccurrences(ctx.file.tree, definitions, extraComponents)) {
      const url = occ.url;
      if (!url) continue;
      if (isExternal(url)) continue;
      // Same page: an in-page anchor, or a query on the current URL.
      if (url.startsWith("#") || url.startsWith("?")) continue;

      if (isRelative(url)) {
        if (allowRelative) continue;
        ctx.report({
          message: `relative link "${url}" — internal docs links should be root-relative (e.g. /foo).`,
          line: occ.line,
          column: occ.column,
        });
        continue;
      }

      // Normalize first so `ignore` sees the same key as the lookup: no
      // trailing slash, hash, or query. Base is never stripped (see header).
      const key = linkRouteKey(url);
      if (matchesAnyIgnore(key, ignore)) continue;
      if (isUnderOpaqueNamespace(key, opaqueNamespaces)) continue;
      if (knownRoutes.has(key)) continue;

      // A link that repeats the base is the likeliest mistake under a
      // non-empty base, and too far from the right route for Levenshtein
      // to find it. Suggest from the path after the base instead.
      const afterBase = withoutBase(key, routes.base);
      const hint =
        afterBase !== null && knownRoutes.has(afterBase)
          ? afterBase
          : suggest(afterBase ?? key, knownRoutes, 3);
      const baseNote =
        afterBase !== null
          ? ` Write links without the base "${routes.base}"; it's added when the page renders.`
          : "";
      ctx.report({
        message: hint
          ? `broken link "${url}" — did you mean "${hint}"?${baseNote}`
          : `broken link "${url}" — no page resolves to this path.${baseNote}`,
        line: occ.line,
        column: occ.column,
        ...(hint
          ? {
              fix: {
                description: `replace "${url}" with "${hint}"`,
                edits: [],
              },
            }
          : {}),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// AST traversal
// ---------------------------------------------------------------------------

interface LinkOccurrence {
  url: string;
  line: number;
  column: number;
}

interface ComponentSpec {
  name: string;
  attr: string;
}

/**
 * `<a href>` is always checked — plain anchors mean the same thing in
 * every MDX file. Extra components come from the `components` option.
 */
function readExtraComponents(value: unknown): ComponentSpec[] {
  if (!Array.isArray(value)) return [];
  const out: ComponentSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { name?: unknown; attr?: unknown };
    if (typeof obj.name === "string" && typeof obj.attr === "string") {
      out.push({ name: obj.name, attr: obj.attr });
    }
  }
  return out;
}

/**
 * Collect every internal-link candidate from the tree, normalized into one
 * shape so the rule's main loop doesn't fork on node type.
 */
function collectLinkOccurrences(
  root: MdNode,
  definitions: Map<string, string>,
  extraComponents: ComponentSpec[],
): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  visit(root, (node) => {
    if (node.type === "link") {
      const at = startOf(node);
      out.push({
        url: typeof node.url === "string" ? node.url : "",
        line: at.line,
        column: at.column,
      });
      return;
    }
    if (node.type === "linkReference") {
      const identifier =
        typeof node.identifier === "string" ? node.identifier : "";
      const url = definitions.get(identifier);
      if (!url) return;
      const at = startOf(node);
      out.push({ url, line: at.line, column: at.column });
      return;
    }
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      if (node.name === "a") {
        const href = readJsxStringAttr(node, "href");
        if (href === null) return;
        const at = startOf(node);
        out.push({ url: href, line: at.line, column: at.column });
        return;
      }
      for (const spec of extraComponents) {
        if (node.name !== spec.name) continue;
        const href = readJsxStringAttr(node, spec.attr);
        if (href === null) return;
        const at = startOf(node);
        out.push({ url: href, line: at.line, column: at.column });
        return;
      }
    }
  });
  return out;
}

function collectDefinitions(root: MdNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of collect(root, "definition")) {
    const id = typeof def.identifier === "string" ? def.identifier : "";
    const url = typeof def.url === "string" ? def.url : "";
    if (id && url && !out.has(id)) out.set(id, url);
  }
  return out;
}

/**
 * Read a string-valued JSX attribute. Returns null when the attribute is
 * absent, dynamic (expression form `<a href={x}>`), or boolean (`<a
 * disabled>`). Static-only on purpose — dynamic hrefs aren't link-checkable.
 */
function readJsxStringAttr(node: MdNode, name: string): string | null {
  const attrs = (node as { attributes?: unknown }).attributes;
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    if (!a || typeof a !== "object") continue;
    const attr = a as { name?: unknown; value?: unknown };
    if (attr.name !== name) continue;
    if (typeof attr.value === "string") return attr.value;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL classification + normalization
// ---------------------------------------------------------------------------

function isExternal(url: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) || // any scheme: http:, mailto:, tel:, …
    url.startsWith("//") // protocol-relative
  );
}

/**
 * Anything that isn't root-relative resolves against the current page:
 * `./foo`, `../foo`, and bare `foo` alike. Checked before normalization,
 * which would turn `foo` into `/foo` and match an unrelated root route.
 */
function isRelative(url: string): boolean {
  return !url.startsWith("/");
}

/**
 * The part of a route key after `base` when the key repeats it, or null.
 * Only for hints: a link that repeats the base is reported either way.
 */
function withoutBase(key: string, base: string): string | null {
  if (base === "") return null;
  if (key === base) return "/";
  return key.startsWith(`${base}/`) ? key.slice(base.length) : null;
}

function isUnderOpaqueNamespace(
  route: string,
  opaqueNamespaces: string[],
): boolean {
  for (const ns of opaqueNamespaces) {
    if (ns === "/") return true;
    if (route === ns) return true;
    if (route.startsWith(`${ns}/`)) return true;
  }
  return false;
}

// Test-only export — clears the process-level cache. Real callers want one
// load per CLI run; tests want isolation between cases.
export function _resetInternalLinkCacheForTests(): void {
  cached = null;
}
