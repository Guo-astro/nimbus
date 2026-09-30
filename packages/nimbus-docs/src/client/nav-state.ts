/**
 * nav-state.ts — Keep a navigation sidebar steady across page loads.
 *
 * A reader who opens groups and scrolls the sidebar expects it to look the
 * same on the next page. Two halves, sharing one `sessionStorage` format:
 *
 *   - `restoreNavState` runs inline, right after the sidebar markup and again
 *     on `astro:after-swap`, before the page is painted and before any
 *     disclosure mounts. It sets remembered groups open by attribute (no
 *     animation), fills loaded groups from the fragment cache, and restores
 *     scroll, keeping the current page's link in view.
 *   - `trackNavState` records open groups and scroll as the reader changes them.
 *
 * Markup contract, on elements inside any container:
 *   - `data-nb-nav-state="<key>"` + `data-nb-nav-scroller="<name>"` on each
 *     scrolling sidebar container (copies with one key share open groups);
 *   - `data-nb-nav-group="<id>"` on each collapsible group root;
 *   - `data-nb-nav-src` on a group whose content loads on demand.
 */

export const NAV_STATE_KEYS = {
  state: "nimbus:nav-state:",
  fragments: "nimbus:nav-fragments",
} as const;

/** Upper bound on cached fragment HTML, well inside `sessionStorage` quotas. */
const FRAGMENT_CACHE_CHARS = 2_000_000;

interface NavState {
  open?: string[];
  scroll?: Record<string, number>;
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

function updateState(key: string, patch: NavState): void {
  const storageKey = NAV_STATE_KEYS.state + key;
  const prior = readJson<NavState>(storageKey) ?? {};
  writeJson(storageKey, {
    ...prior,
    ...patch,
    ...(patch.scroll ? { scroll: { ...prior.scroll, ...patch.scroll } } : {}),
  });
}

/** A fragment cached earlier in this session, if any. */
export function cachedNavFragment(src: string): string | undefined {
  return readJson<Record<string, string>>(NAV_STATE_KEYS.fragments)?.[src];
}

/** Remember a loaded fragment so the next page can show it before painting. */
export function cacheNavFragment(src: string, html: string): void {
  const cache = readJson<Record<string, string>>(NAV_STATE_KEYS.fragments) ?? {};
  delete cache[src];
  cache[src] = html;
  let size = Object.values(cache).reduce((n, v) => n + v.length, 0);
  for (const oldest of Object.keys(cache)) {
    if (size <= FRAGMENT_CACHE_CHARS) break;
    size -= cache[oldest]!.length;
    delete cache[oldest];
  }
  writeJson(NAV_STATE_KEYS.fragments, cache);
}

/** Record open groups and scroll for one sidebar container. */
export function trackNavState(root: HTMLElement): () => void {
  const key = root.dataset.nbNavState;
  if (!key) return () => {};
  const scroller = root.dataset.nbNavScroller ?? "default";

  // Each change is applied to the saved set on its own (open adds the group,
  // close removes it), never as a snapshot of this copy. A copy that is out
  // of date (the other breakpoint's sidebar) then cannot erase what the
  // reader did in the copy they were using.
  const storageKey = NAV_STATE_KEYS.state + key;
  const openGroups = () => new Set(readJson<NavState>(storageKey)?.open ?? []);
  // Groups open as the page mounts (its trail, plus what was just restored)
  // count as open: both copies agree at this point, so adding them is safe.
  const initial = openGroups();
  root.querySelectorAll<HTMLElement>("[data-nb-nav-group]").forEach((group) => {
    const trigger = group.querySelector("[data-nb-collapsible-trigger]");
    if (trigger?.getAttribute("data-nb-state") === "open") initial.add(group.dataset.nbNavGroup!);
  });
  updateState(key, { open: [...initial] });

  const observer = new MutationObserver((records) => {
    const changes = new Map<string, boolean>();
    for (const record of records) {
      const trigger = record.target as Element;
      const state = trigger.getAttribute("data-nb-state");
      if (record.oldValue === state || !trigger.hasAttribute("data-nb-collapsible-trigger")) continue;
      const id = trigger.closest<HTMLElement>("[data-nb-nav-group]")?.dataset.nbNavGroup;
      if (id) changes.set(id, state === "open");
    }
    if (changes.size === 0) return;
    const open = openGroups();
    for (const [id, isOpen] of changes) {
      if (isOpen) open.add(id);
      else open.delete(id);
    }
    updateState(key, { open: [...open] });
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-nb-state"],
  });

  // A hidden copy (the other breakpoint's sidebar) has no scroll to keep.
  const saveScroll = () => {
    if (root.clientHeight > 0) updateState(key, { scroll: { [scroller]: root.scrollTop } });
  };

  let frame = 0;
  const onScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(saveScroll);
  };
  root.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pagehide", saveScroll);

  return () => {
    saveScroll();
    observer.disconnect();
    cancelAnimationFrame(frame);
    root.removeEventListener("scroll", onScroll);
    window.removeEventListener("pagehide", saveScroll);
  };
}

/**
 * Restore every `[data-nb-nav-state]` container from `sessionStorage`, or
 * only the groups inside `scope` (rows a script just inserted).
 * Self-contained: it is serialized into an inline script (see
 * `navStateScript` in `@cloudflare/nimbus-docs/runtime`), so it may reference
 * nothing outside its own body.
 */
export function restoreNavState(keys: typeof NAV_STATE_KEYS, scope?: Element): void {
  const read = (key: string) => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
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
    const trigger = group.querySelector("[data-nb-collapsible-trigger]");
    const panel = group.querySelector("[data-nb-collapsible-content]");
    hush(panel);
    hush(trigger);
    if (trigger) trigger.querySelectorAll("*").forEach(hush);
    if (trigger) {
      trigger.setAttribute("data-nb-state", "open");
      trigger.setAttribute("aria-expanded", "true");
    }
    if (panel) {
      panel.setAttribute("data-nb-state", "open");
      panel.removeAttribute("inert");
    }
  };
  const fill = (group: Element, fragments: Record<string, string>) => {
    const src = group.getAttribute("data-nb-nav-src");
    const panel = group.querySelector("[data-nb-collapsible-content]");
    const html = src && fragments[src];
    if (!html || !panel || panel.hasAttribute("data-nb-deferred-loaded")) return false;
    const template = document.createElement("template");
    template.innerHTML = html;
    template.content.querySelectorAll("script").forEach((s) => s.remove());
    const source = template.content.querySelector("[data-nb-collapsible-content]");
    if (!source) return false;
    panel.replaceChildren(...Array.from(source.childNodes));
    panel.setAttribute("data-nb-deferred-loaded", "");
    return true;
  };
  const restoreRoot = (root: HTMLElement, within: Element) => {
      const fragments = read(keys.fragments) || {};
      const state = read(keys.state + root.getAttribute("data-nb-nav-state")) || {};
      const open = new Set<string>(Array.isArray(state.open) ? state.open : []);
      const seen = new Set<Element>();
      // Filling a group can reveal remembered groups inside it; repeat until stable.
      for (let changed = open.size > 0; changed; ) {
        changed = false;
        within.querySelectorAll("[data-nb-nav-group]").forEach((group) => {
          if (seen.has(group)) return;
          seen.add(group);
          if (!open.has(group.getAttribute("data-nb-nav-group") || "")) return;
          setOpen(group);
          if (fill(group, fragments)) changed = true;
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
      if (within !== root || root.clientHeight === 0) return;
      const saved = state.scroll && state.scroll[root.getAttribute("data-nb-nav-scroller") || "default"];
      if (typeof saved === "number") root.scrollTop = saved;
      const active = root.querySelector("[aria-current='page']");
      if (!active) return;
      const box = root.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      if (item.top < box.top || item.bottom > box.bottom) {
        root.scrollTop += item.top - box.top - box.height / 2 + item.height / 2;
      }
  };
  if (scope) {
    const root = scope.closest<HTMLElement>("[data-nb-nav-state]");
    if (root) restoreRoot(root, scope);
    return;
  }
  const restore = () =>
    document
      .querySelectorAll<HTMLElement>("[data-nb-nav-state]")
      .forEach((root) => restoreRoot(root, root));
  restore();
  const flag = "__nbNavStateBound";
  const w = window as unknown as Record<string, boolean>;
  if (!w[flag]) {
    w[flag] = true;
    document.addEventListener("astro:after-swap", restore);
  }
}
