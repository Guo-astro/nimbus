/**
 * Bounded API navigation — the rule behind `api[].sidebar: "on-demand"`.
 *
 * A full API tree in every page makes page size grow with the whole API. The
 * bounded mode keeps only what a reader at this position needs:
 *
 *   - every top-level item;
 *   - on the active trail (items flagged `active`/`expanded`), every child;
 *   - everything else collapsed: `deferred: true`, no children, and a
 *     `childrenHref` naming the page whose sidebar already lists them.
 *
 * A group with a page loads its rows from that page: there the group is the
 * current item, so its children appear exactly as they would when opened from
 * anywhere else. A group without a page (an `x-tagGroups` category) loads
 * them from the API overview, which lists every such group's children. Without
 * JavaScript, a collapsed group's label is still a link to its page, and the
 * overview's body lists every section.
 *
 * The rule reads only the nav's flags, never a model, so it applies equally to
 * the static projection, request rendering from the prepared nav, and tests.
 */

import type { ApiSidebarMode, PrevNext } from "../../types.js";
import { toDocumentHref } from "../url.js";
import type { ApiNav, ApiNavItem } from "./api-view-types.js";

export interface BoundApiNavOptions {
  mode: ApiSidebarMode;
  /** Where the API is mounted: its overview, at `mountPath`, lists every page-less group's rows. */
  mountPath: string;
  /** Public URL base when it differs from `mountPath` (query mode). */
  urlBasePath?: string;
  /** Query string same-version links carry (query mode, non-default). */
  urlQuery?: string;
  /** The page being rendered is the API overview. */
  overview?: boolean;
}

/** Apply a `sidebar` mode to an activated nav. `"full"` returns `nav` itself. */
export function applyApiSidebarMode(nav: ApiNav, options: BoundApiNavOptions): ApiNav {
  if (options.mode === "full") return nav;
  // Without the version's query, an old-version page would load the default
  // version's navigation for a page-less group.
  const overviewHref = `${toDocumentHref((options.urlBasePath ?? options.mountPath) || "/")}${options.urlQuery ?? ""}`;
  const bound = (items: ApiNavItem[]): ApiNavItem[] => items.map(boundItem);
  const boundItem = (item: ApiNavItem): ApiNavItem => {
    if (item.children.length === 0) return item;
    const pageless = item.href === undefined;
    // The overview is where page-less groups' rows load from, so it keeps them.
    if (item.active || item.expanded || (pageless && options.overview)) {
      return { ...item, children: bound(item.children) };
    }
    const { children: _children, ...rest } = item;
    return { ...rest, deferred: true, children: [], childrenHref: item.href ?? overviewHref };
  };
  return { ...nav, items: bound(nav.items) };
}

// Every page in sidebar order, computed once per nav tree.
const pageOrders = new WeakMap<readonly ApiNavItem[], { links: ApiNavItem[]; index: Map<string, number> }>();

/** The pages before and after `coordinate` in sidebar order, whether or not a
 *  bounded sidebar shows them; undefined when it isn't a page in `items`. One
 *  nav is one version, so links stay in it. */
export function apiPrevNext(items: readonly ApiNavItem[], coordinate: string): PrevNext | undefined {
  let order = pageOrders.get(items);
  if (!order) {
    const links: ApiNavItem[] = [];
    const visit = (item: ApiNavItem) => {
      if (item.href !== undefined) links.push(item);
      item.children.forEach(visit);
    };
    items.forEach(visit);
    order = { links, index: new Map(links.map((item, i) => [item.coordinate, i])) };
    pageOrders.set(items, order);
  }
  const at = order.index.get(coordinate);
  if (at === undefined) return undefined;
  const link = (item: ApiNavItem | undefined) => (item ? { label: item.label, href: item.href! } : undefined);
  const prev = link(order.links[at - 1]);
  const next = link(order.links[at + 1]);
  return { ...(prev && { prev }), ...(next && { next }) };
}

/** Every group (an item with children) in `nav`, in tree order. */
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
