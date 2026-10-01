/**
 * nav-sidebar.ts — Keep a navigation sidebar steady across pages, and load
 * collapsed groups (`sidebar: "on-demand"`) when they open.
 *
 * Two halves, sharing one `sessionStorage` format:
 *
 *   - `restoreNavState` runs inline, right after the sidebar markup (see
 *     `navStateScript` in `@cloudflare/nimbus-docs/runtime`), and again after a
 *     view-transition swap, before paint and before any disclosure mounts. It
 *     reopens the groups the reader left open (without animating), fills
 *     their rows from the session cache, and restores scroll.
 *   - `initNavSidebar` records what the reader changes and loads a collapsed
 *     group's rows from the page its `data-nb-nav-src` names, where that
 *     group is listed open.
 *
 * Markup contract:
 *   - `data-nb-nav-state="<key>"` + `data-nb-nav-scroller="<name>"` on each
 *     scrolling sidebar container (copies with one key share open groups),
 *     with `data-nb-nav-build={navBuildId}` (from the runtime) naming the
 *     build that rendered it. Rows cached by another build are never shown;
 *     without it, rows are not cached;
 *   - `data-nb-nav-group="<id>"` on each collapsible group root;
 *   - `data-nb-nav-src="<url>"` on a group whose rows were left out of this
 *     page; removed once they are filled in. Its panel is empty apart from
 *     the disclosure's own wrapper, and is replaced wholesale.
 */

import { remount } from "./mount";

export const NAV_STATE_KEYS = {
  state: "nimbus:nav-state:",
  rows: "nimbus:nav-rows",
} as const;

const BUILD = "data-nb-nav-build";
const GROUP = "data-nb-nav-group";
const SRC = "data-nb-nav-src";
const TRIGGER = "[data-nb-collapsible-trigger]";
const CONTENT = "[data-nb-collapsible-content]";

/** Upper bound on cached rows, well inside `sessionStorage` quotas. */
const ROWS_CACHE_CHARS = 500_000;
/** Fetched pages kept in memory, so sibling groups served by one page share it. */
const PAGE_CACHE_SIZE = 8;

interface NavState {
  open?: string[];
  scroll?: Record<string, number>;
  /** Per scroller: the link the reader last clicked, and its distance from
   *  the container's top, so the next page can keep it in place. Used once. */
  anchor?: Record<string, { href: string; offset: number }>;
}

interface RowsCache {
  build: string;
  rows: Record<string, string>;
}


function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const rowsKey = (src: string, group: string) => `${src} ${group}`;

function cacheRows(build: string, key: string, html: string): void {
  if (!build) return;
  const prior = readJson<RowsCache>(NAV_STATE_KEYS.rows);
  const rows = prior?.build === build ? prior.rows : {};
  delete rows[key];
  rows[key] = html;
  let size = Object.values(rows).reduce((n, v) => n + v.length, 0);
  for (const oldest of Object.keys(rows)) {
    if (size <= ROWS_CACHE_CHARS) break;
    size -= rows[oldest]!.length;
    delete rows[oldest];
  }
  writeJson(NAV_STATE_KEYS.rows, { build, rows } satisfies RowsCache);
}

// Fetched pages, kept in memory across view transitions. Keyed by the build
// of the page asking, so a deploy mid-session never serves the old build's
// pages from memory.
const pages = new Map<string, Promise<Document>>();

/** `src` as a same-origin page URL, or `undefined`: rows (markup) and the
 *  failure fallback (a navigation) only ever come from this site. */
function pageUrl(src: string | null): string | undefined {
  if (!src) return undefined;
  try {
    const url = new URL(src, window.location.href);
    const web = url.protocol === "https:" || url.protocol === "http:";
    return web && url.origin === window.location.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function fetchPage(src: string, build: string): Promise<Document> {
  const key = `${build} ${src}`;
  let pending = pages.get(key);
  if (pending) {
    pages.delete(key);
    pages.set(key, pending);
    return pending;
  }
  const get = async (cache: RequestCache) => {
    const response = await fetch(src, { credentials: "same-origin", cache });
    if (!response.ok) throw new Error(`${response.status} ${src}`);
    // Rows are markup: a redirect must not take them from another site.
    if (response.redirected && !pageUrl(response.url)) {
      throw new Error(`${src} redirected off-site`);
    }
    return new DOMParser().parseFromString(await response.text(), "text/html");
  };
  // A page from another build came from a cache (browser or edge) that missed
  // a deploy: ask the server once more, bypassing caches.
  const buildOf = (doc: Document) => doc.querySelector(`[${BUILD}]`)?.getAttribute(BUILD);
  pending = get("default").then((doc) =>
    build && buildOf(doc) && buildOf(doc) !== build ? get("reload") : doc,
  );
  pages.set(key, pending);
  pending.catch(() => {
    if (pages.get(key) === pending) pages.delete(key);
  });
  for (const oldest of pages.keys()) {
    if (pages.size <= PAGE_CACHE_SIZE) break;
    pages.delete(oldest);
  }
  return pending;
}

/** The rows `page` lists for group `id`, or `undefined` if it lists none. */
function rowsIn(page: Document, id: string): DocumentFragment | undefined {
  for (const group of page.querySelectorAll(`[${GROUP}]`)) {
    if (group.getAttribute(GROUP) !== id || group.hasAttribute(SRC)) continue;
    const panel = group.querySelector(CONTENT);
    if (!panel) continue;
    const rows = document.createDocumentFragment();
    for (const child of Array.from(panel.childNodes)) rows.append(document.importNode(child, true));
    // Inserted scripts never run; the page already has the ones it needs.
    rows.querySelectorAll("script").forEach((script) => script.remove());
    return rows;
  }
  return undefined;
}

/**
 * Record open groups and scroll for one sidebar container, and load its
 * collapsed groups' rows as they open. Returns a teardown.
 */
export function initNavSidebar(root: HTMLElement): () => void {
  const key = root.dataset.nbNavState;
  if (!key) return () => {};
  const scroller = root.dataset.nbNavScroller ?? "default";
  const build = root.getAttribute(BUILD) ?? "";
  const storageKey = NAV_STATE_KEYS.state + key;
  let destroyed = false;

  const readState = () => readJson<NavState>(storageKey) ?? {};
  const updateState = (patch: NavState) => {
    const prior = readState();
    writeJson(storageKey, {
      ...prior,
      ...patch,
      ...(patch.scroll ? { scroll: { ...prior.scroll, ...patch.scroll } } : {}),
    });
  };

  const panelOf = (group: Element) => group.querySelector<HTMLElement>(CONTENT);
  const prefetch = (group: Element) => {
    const url = pageUrl(group.getAttribute(SRC));
    if (url) void fetchPage(url, build).catch(() => {});
  };

  // `follow`: if the rows cannot load, go to the page that lists them. Only
  // when the reader opened the group; a group restored open never redirects.
  const load = async (group: HTMLElement, follow: boolean) => {
    const src = group.getAttribute(SRC);
    const url = pageUrl(src);
    const id = group.getAttribute(GROUP);
    const panel = panelOf(group);
    if (!src || !url || !id || !panel || panel.hasAttribute("aria-busy")) return;
    panel.setAttribute("aria-busy", "true");
    try {
      const source = await fetchPage(url, build);
      const rows = rowsIn(source, id);
      if (destroyed || !panel.isConnected) return;
      if (!rows) throw new Error(`${src} does not list ${id}`);
      if (!group.hasAttribute(SRC)) return;
      panel.replaceChildren(rows);
      group.removeAttribute(SRC);
      // Cache only rows from this page's own build (an edge or browser cache
      // can still serve a page from another one).
      if (source.querySelector(`[${BUILD}]`)?.getAttribute(BUILD) === build) {
        cacheRows(build, rowsKey(src, id), panel.innerHTML);
      }
      // Reopen remembered groups inside the new rows before they mount.
      restoreNavState(NAV_STATE_KEYS, panel);
      remount();
    } catch {
      const isOpen = group.querySelector(TRIGGER)?.getAttribute("data-nb-state") === "open";
      if (follow && !destroyed && isOpen) window.location.assign(url);
    } finally {
      panel.removeAttribute("aria-busy");
    }
  };

  // Each change the reader makes is applied to the saved set on its own
  // (open adds the group, close removes it), never as a snapshot of this
  // copy, so a copy that is out of date (the other breakpoint's sidebar)
  // cannot erase what the reader did in the copy they were using. Groups the
  // page opened itself (its trail) are not saved.
  const observer = new MutationObserver((records) => {
    const changes = new Map<HTMLElement, boolean>();
    for (const record of records) {
      const trigger = record.target as Element;
      const state = trigger.getAttribute("data-nb-state");
      if (record.oldValue === state || !trigger.matches(TRIGGER)) continue;
      const group = trigger.closest<HTMLElement>(`[${GROUP}]`);
      if (group) changes.set(group, state === "open");
    }
    if (changes.size === 0) return;
    const open = new Set(readState().open ?? []);
    for (const [group, isOpen] of changes) {
      const id = group.getAttribute(GROUP)!;
      if (isOpen) open.add(id);
      else open.delete(id);
      if (isOpen) void load(group, true);
    }
    updateState({ open: [...open] });
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-nb-state"],
  });

  // Groups restored open whose rows were not cached.
  root.querySelectorAll<HTMLElement>(`[${SRC}]`).forEach((group) => {
    if (group.querySelector(TRIGGER)?.getAttribute("data-nb-state") === "open") {
      void load(group, false);
    }
  });

  // Prefetch on intent: pointer over or focus on a collapsed group's header.
  const onIntent = (event: Event) => {
    const target = event.target as Element | null;
    const group = target?.closest?.(`[${SRC}]`);
    if (group && !panelOf(group)?.contains(target)) prefetch(group);
  };
  root.addEventListener("pointerover", onIntent, { passive: true });
  root.addEventListener("focusin", onIntent);

  // A hidden copy (the closed mobile drawer, or the rail on a phone) has no
  // scroll to save; its saved scroll is applied when it becomes visible.
  const saveScroll = () => {
    if (root.clientHeight > 0) updateState({ scroll: { [scroller]: root.scrollTop } });
  };
  let frame = 0;
  const onScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(saveScroll);
  };
  root.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pagehide", saveScroll);

  // Collapsing the old page's trail moves the rows below it; remembering
  // where the clicked link sat keeps it under the pointer on the next page.
  const onClick = (event: Event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!link || !root.contains(link)) return;
    const offset = link.getBoundingClientRect().top - root.getBoundingClientRect().top;
    updateState({ anchor: { [scroller]: { href: link.getAttribute("href")!, offset } } });
  };
  root.addEventListener("click", onClick);

  // A container restored while hidden (the closed mobile drawer) gets its
  // scroll when it is first shown. Only its scroll: its disclosures have
  // mounted, and own their state from here on.
  let visible = root.clientHeight > 0;
  const resize =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          const nowVisible = root.clientHeight > 0;
          if (nowVisible && !visible) restoreNavState(NAV_STATE_KEYS, root, true);
          visible = nowVisible;
        });
  resize?.observe(root);

  return () => {
    destroyed = true;
    saveScroll();
    observer.disconnect();
    resize?.disconnect();
    cancelAnimationFrame(frame);
    root.removeEventListener("click", onClick);
    root.removeEventListener("pointerover", onIntent);
    root.removeEventListener("focusin", onIntent);
    root.removeEventListener("scroll", onScroll);
    window.removeEventListener("pagehide", saveScroll);
  };
}

/**
 * Restore every `[data-nb-nav-state]` container not yet restored, or only
 * the groups inside `scope` (rows a script just inserted). A `scope` that is
 * a container itself is restored in full, scroll included; with `scrollOnly`,
 * only its scroll (a container whose disclosures have already mounted).
 *
 * Self-contained: it is serialized into an inline script, so it may reference
 * nothing outside its own body.
 */
export function restoreNavState(
  keys: typeof NAV_STATE_KEYS,
  scope?: Element,
  scrollOnly = false,
): void {
  const read = (key: string) => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  };
  const restoredAttr = "data-nb-nav-restored";
  const triggerSel = "[data-nb-collapsible-trigger]";
  const contentSel = "[data-nb-collapsible-content]";
  // The build id comes from the container being restored, never from this
  // closure: after a view-transition swap, the listener registered by an
  // earlier page (possibly an earlier deployment) restores the new markup.
  let cache: { build?: string; rows?: Record<string, string> } | null | undefined;
  const cachedRows = (root: Element, key: string) => {
    const build = root.getAttribute("data-nb-nav-build");
    if (!build) return undefined;
    if (cache === undefined) cache = read(keys.rows);
    return cache && cache.build === build && cache.rows ? cache.rows[key] : undefined;
  };
  // Restored groups appear open, never opening: transitions stay off until
  // the restored state has been painted.
  const quiet: Array<HTMLElement | SVGElement> = [];
  const hush = (el: Element | null) => {
    // SVG too: the caret icon carries the rotate transition.
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return;
    el.style.transition = "none";
    quiet.push(el);
  };
  const setOpen = (group: Element) => {
    group.setAttribute("data-nb-default-open", "true");
    const trigger = group.querySelector(triggerSel);
    const panel = group.querySelector(contentSel);
    hush(panel);
    hush(trigger);
    if (trigger) {
      trigger.querySelectorAll("*").forEach(hush);
      trigger.setAttribute("data-nb-state", "open");
      trigger.setAttribute("aria-expanded", "true");
    }
    if (panel) {
      panel.setAttribute("data-nb-state", "open");
      panel.removeAttribute("inert");
    }
  };
  // Only a group whose rows were left out is filled; rows the server rendered
  // (the current page's trail, with its highlight) are never replaced.
  const fill = (root: Element, group: Element) => {
    const src = group.getAttribute("data-nb-nav-src");
    const panel = group.querySelector(contentSel);
    if (!src || !panel) return false;
    const html = cachedRows(root, `${src} ${group.getAttribute("data-nb-nav-group")}`);
    if (!html) return false;
    const template = document.createElement("template");
    template.innerHTML = html;
    template.content.querySelectorAll("script").forEach((s) => s.remove());
    panel.replaceChildren(template.content);
    group.removeAttribute("data-nb-nav-src");
    return true;
  };
  const restoreRoot = (root: HTMLElement, within: Element) => {
    cache = undefined; // read fresh each pass: a listener outlives many pages
    const stateKey = keys.state + root.getAttribute("data-nb-nav-state");
    const state = read(stateKey) || {};
    const open = new Set<string>(Array.isArray(state.open) ? state.open : []);
    const seen = new Set<Element>();
    // Filling a group can reveal remembered groups inside it; repeat until stable.
    for (let changed = !scrollOnly && open.size > 0; changed; ) {
      changed = false;
      within.querySelectorAll("[data-nb-nav-group]").forEach((group) => {
        if (seen.has(group)) return;
        seen.add(group);
        if (!open.has(group.getAttribute("data-nb-nav-group") || "")) return;
        setOpen(group);
        if (fill(root, group)) changed = true;
      });
    }
    if (quiet.length > 0) {
      // Two frames: the restored values must be painted once before
      // transitions return (a forced style flush is not enough inside a
      // view-transition update).
      const settled = quiet.splice(0);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => settled.forEach((el) => (el.style.transition = ""))),
      );
    }
    // Scroll: a hidden container has none; it is restored when shown.
    if (within !== root || root.clientHeight === 0) return;
    const scroller = root.getAttribute("data-nb-nav-scroller") || "default";
    const saved = state.scroll && state.scroll[scroller];
    if (typeof saved === "number") root.scrollTop = saved;
    const anchor = state.anchor && state.anchor[scroller];
    if (anchor) {
      delete state.anchor[scroller];
      try {
        sessionStorage.setItem(stateKey, JSON.stringify(state));
      } catch {}
    }
    const active = root.querySelector("[aria-current='page']");
    if (!active) return;
    const box = root.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (anchor && active.getAttribute("href") === anchor.href) {
      // The link the reader clicked stays where it was.
      root.scrollTop += item.top - box.top - anchor.offset;
    } else if (item.top < box.top || item.bottom > box.bottom) {
      root.scrollTop += item.top - box.top - box.height / 2 + item.height / 2;
    }
  };
  if (scope) {
    const root = scope.closest<HTMLElement>("[data-nb-nav-state]");
    if (root) restoreRoot(root, scope);
    return;
  }
  // Once per container: the inline script and the swap listener both reach
  // a swapped-in sidebar.
  const restore = () =>
    document.querySelectorAll<HTMLElement>("[data-nb-nav-state]").forEach((root) => {
      if (root.hasAttribute(restoredAttr)) return;
      root.setAttribute(restoredAttr, "");
      restoreRoot(root, root);
    });
  restore();
  const flag = "__nbNavStateBound";
  const w = window as unknown as Record<string, boolean>;
  if (!w[flag]) {
    w[flag] = true;
    document.addEventListener("astro:after-swap", restore);
  }
}
