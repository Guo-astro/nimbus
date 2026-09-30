/**
 * Bounded API navigation — the one rule behind the `api[].sidebar` modes.
 *
 * A full API tree in every page makes page size grow with the whole API (the
 * Cloudflare API's tree is ~80% of every page). The bounded modes keep only
 * what a reader at this position needs:
 *
 *   - every top-level item;
 *   - on the active trail (items flagged `active`/`expanded`), every child;
 *   - everything else collapsed: `deferred: true` with no children.
 *
 * A group with no page of its own (an `x-tagGroups` category) keeps its
 * children, each bounded, in both modes: it has no page to link to, so
 * without JavaScript it would otherwise lead nowhere. In `"on-demand"` mode
 * every other collapsed group is deferred with the URL its children load
 * from, and other groups on the active trail carry that URL too, for caching.
 *
 * The rule reads only the nav's flags, never a model, so it applies equally to
 * `getApiNav`, the static projection, request rendering from the prepared nav,
 * and a nav a site builds itself.
 */

import type { ApiSidebarMode } from "../../types.js";
import { toDocumentHref } from "../url.js";
import type { ApiNav, ApiNavItem } from "./api-view-types.js";

export interface BoundApiNavOptions {
  mode: ApiSidebarMode;
  /** The URL a deferred group's children load from, in `"on-demand"` mode. */
  childrenHref?: (item: ApiNavItem) => string | undefined;
}

/** Apply a `sidebar` mode to an activated nav. `"full"` returns `nav` itself. */
export function boundApiNav(nav: ApiNav, options: BoundApiNavOptions): ApiNav {
  if (options.mode === "full") return nav;
  return { ...nav, items: boundItems(nav.items, options) };
}

/**
 * Apply a configured `sidebar` mode to the nav of the API mounted at
 * `mountPath`, pointing deferred groups at Nimbus's fragment route. Every
 * Nimbus output path (static, build-rendered, request-rendered) goes through
 * this one function.
 */
export function applyApiSidebarMode(
  nav: ApiNav,
  mode: ApiSidebarMode,
  mountPath: string,
  revision?: string,
): ApiNav {
  return boundApiNav(nav, configuredOptions(mode, mountPath, revision));
}

// Keyed on `items`: projections rebuild the `ApiNav` wrapper but share the tree.
const revisions = new WeakMap<ApiNavItem[], string>();

/**
 * A hash of the full, unactivated nav. It versions every fragment URL, so a
 * tab still holding rows from an earlier deployment never reuses them: any
 * change to the tree changes every URL, which misses every cache.
 */
export function apiNavRevision(nav: ApiNav): string {
  let revision = revisions.get(nav.items);
  if (revision === undefined) {
    revision = fnv1a(JSON.stringify(nav.items));
    revisions.set(nav.items, revision);
  }
  return revision;
}

/**
 * One `"on-demand"` fragment: the group, off any page's trail, with its
 * children bounded exactly as a page would show them once the group opens.
 * `nav` is the full, unactivated tree. `undefined` for a non-group.
 */
export function apiNavFragment(
  nav: ApiNav,
  coordinate: string,
  mountPath: string,
): ApiNavItem | undefined {
  const children = apiNavGroupChildren(
    nav,
    coordinate,
    configuredOptions("on-demand", mountPath, apiNavRevision(nav)),
  );
  if (!children) return undefined;
  const group = offTrail(findItem(nav.items, coordinate)!);
  return { ...group, children };
}

/** Fragment key → group coordinate for every group in `nav`. Throws if two
 *  coordinates share a key, which would silently serve the wrong group. */
export function apiNavFragmentIndex(nav: ApiNav): Map<string, string> {
  const index = new Map<string, string>();
  for (const { coordinate } of apiNavGroups(nav)) {
    const key = apiNavGroupKey(coordinate);
    const prior = index.get(key);
    if (prior !== undefined && prior !== coordinate) {
      throw new Error(
        `nimbus-docs api: navigation groups "${prior}" and "${coordinate}" share the fragment key "${key}". ` +
          'Rename one tag, or set `sidebar: "links"` for this collection.',
      );
    }
    index.set(key, coordinate);
  }
  return index;
}

function configuredOptions(
  mode: ApiSidebarMode,
  mountPath: string,
  revision: string | undefined,
): BoundApiNavOptions {
  return {
    mode,
    childrenHref: (item) => apiNavFragmentHref(mountPath, item.coordinate, revision),
  };
}

/**
 * The children of one group as they appear when the group is opened from its
 * collapsed state: each child bounded as if off the active trail. `undefined`
 * when the nav has no such group.
 */
export function apiNavGroupChildren(
  nav: ApiNav,
  coordinate: string,
  options: BoundApiNavOptions,
): ApiNavItem[] | undefined {
  const group = findItem(nav.items, coordinate);
  if (!group || group.children.length === 0) return undefined;
  return boundItems(group.children.map(offTrail), options);
}

/** Every group a bounded mode may defer, in tree order. */
export function apiNavGroups(nav: ApiNav): ApiNavItem[] {
  const out: ApiNavItem[] = [];
  const visit = (item: ApiNavItem) => {
    if (item.children.length === 0) return;
    out.push(item);
    item.children.forEach(visit);
  };
  nav.items.forEach(visit);
  return out;
}

/** The path prefix under which `"on-demand"` group fragments are served. */
export const API_NAV_FRAGMENT_PREFIX = "/nimbus-api/nav";

/**
 * The fragment URL for one group of the API mounted at `mountPath`. The last
 * segment is a readable slug plus a hash of the exact coordinate, so it stays
 * URL-safe for any tag name. `revision` (see `apiNavRevision`) becomes a `v`
 * query parameter that the route ignores and caches key on.
 */
export function apiNavFragmentHref(mountPath: string, coordinate: string, revision?: string): string {
  const href = toDocumentHref(`${API_NAV_FRAGMENT_PREFIX}${mountPath}/${apiNavGroupKey(coordinate)}`);
  return revision ? `${href}?v=${revision}` : href;
}

export function apiNavGroupKey(coordinate: string): string {
  const slug = coordinate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "group"}-${fnv1a(coordinate)}`;
}

function boundItems(items: ApiNavItem[], options: BoundApiNavOptions): ApiNavItem[] {
  return items.map((item) => boundItem(item, options));
}

function boundItem(item: ApiNavItem, options: BoundApiNavOptions): ApiNavItem {
  if (item.children.length === 0) return item;
  const onTrail = item.active || item.expanded;
  const pageless = item.href === undefined;
  if (onTrail || pageless) {
    const open: ApiNavItem = { ...item, children: boundItems(item.children, options) };
    // A trail group still names its fragment, so the sidebar can cache it
    // and show the group at once on pages where it is collapsed. A page-less
    // group is never collapsed that way, so it needs none.
    if (options.mode === "on-demand" && onTrail && !pageless) {
      const href = options.childrenHref?.(item);
      if (href) open.childrenHref = href;
    }
    return open;
  }
  const { children: _children, ...rest } = item;
  const deferred: ApiNavItem = { ...rest, deferred: true, children: [] };
  if (options.mode === "on-demand") {
    const href = options.childrenHref?.(item);
    if (href) deferred.childrenHref = href;
  }
  return deferred;
}

// A fragment is shared by every page, so it must not carry any page's trail.
function offTrail(item: ApiNavItem): ApiNavItem {
  if (!item.active && !item.expanded) return item;
  const { active: _active, expanded: _expanded, ...rest } = item;
  return { ...rest, children: rest.children.map(offTrail) };
}

function findItem(items: ApiNavItem[], coordinate: string): ApiNavItem | undefined {
  for (const item of items) {
    if (item.coordinate === coordinate) return item;
    const found = findItem(item.children, coordinate);
    if (found) return found;
  }
  return undefined;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
