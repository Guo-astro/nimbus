/**
 * deferred-content.ts — Load a disclosure's content the first time it opens.
 *
 * Built for `sidebar: "on-demand"` API navigation, where a collapsed group's
 * rows are left out of the page and served as a prebuilt HTML fragment. Owns:
 *
 *   - prefetch on intent (pointer over, focus, or touch on the trigger), so
 *     opening usually shows rows at once;
 *   - loading when the trigger's `data-nb-state` becomes `"open"`, however it
 *     opened (click, keyboard, restored state);
 *   - one request per URL for the session, shared by every copy of the
 *     sidebar and kept across view transitions;
 *   - caching loaded HTML for the session, so `restoreNavState` can show a
 *     remembered group's rows on the next page before it paints;
 *   - `remount()` after insertion, so components inside the rows wire up.
 *
 * Content already marked `data-nb-deferred-loaded` (filled by
 * `restoreNavState`) is left as is.
 *
 * The disclosure itself stays in charge of open/closed state and ARIA; this
 * module only fills the content. If a load fails, the group can be opened
 * again to retry, and `fallbackHref` (the group's own page) is followed.
 */

import { remount } from "./mount";
import {
  NAV_STATE_KEYS,
  cacheNavFragment,
  cachedNavFragment,
  restoreNavState,
} from "./nav-state";

export interface DeferredContentOptions {
  /** The disclosure trigger. Its `data-nb-state` drives loading. */
  trigger: HTMLElement;
  /** The disclosure content the loaded markup replaces. */
  content: HTMLElement;
  /** Fragment URL (already base-aware). */
  src: string;
  /** Selector for the element in the fragment whose children are inserted. */
  select: string;
  /** Where to go if the fragment cannot load, e.g. the group's page. */
  fallbackHref?: string;
  /** The content is already in the page (the server rendered it open). It is
   *  not replaced; the fragment is fetched when the browser is idle, so pages
   *  where this group is collapsed can show it at once. */
  loaded?: boolean;
}

export interface DeferredContentInstance {
  /** Load now (no-op once loaded or loading). */
  load(): Promise<void>;
  destroy(): void;
}

const fragments = new Map<string, Promise<string>>();
const LOADED = "data-nb-deferred-loaded";

function fetchFragment(src: string): Promise<string> {
  let pending = fragments.get(src);
  const cached = pending ? undefined : cachedNavFragment(src);
  if (cached !== undefined) {
    pending = Promise.resolve(cached);
    fragments.set(src, pending);
  }
  if (!pending) {
    pending = fetch(src, { credentials: "same-origin" }).then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${src}`);
      return response.text();
    });
    pending.then((html) => cacheNavFragment(src, html), () => {});
    fragments.set(src, pending);
    pending.catch(() => {
      if (fragments.get(src) === pending) fragments.delete(src);
    });
  }
  return pending;
}

export function deferContent(opts: DeferredContentOptions): DeferredContentInstance {
  const { trigger, content, src, select, fallbackHref } = opts;
  if (opts.loaded) content.setAttribute(LOADED, "");
  let state: "idle" | "loading" | "loaded" = content.hasAttribute(LOADED)
    ? "loaded"
    : "idle";
  const isOpen = () => trigger.getAttribute("data-nb-state") === "open";

  async function load(): Promise<void> {
    if (state !== "idle") return;
    state = "loading";
    content.setAttribute("aria-busy", "true");
    try {
      const template = document.createElement("template");
      template.innerHTML = await fetchFragment(src);
      // Inserted scripts never run; the page already has the ones it needs.
      template.content.querySelectorAll("script").forEach((script) => script.remove());
      const source = template.content.querySelector(select);
      if (!source) throw new Error(`${src} has no ${select}`);
      content.replaceChildren(...source.childNodes);
      content.setAttribute(LOADED, "");
      state = "loaded";
      // Reopen remembered groups inside the new rows before they mount.
      restoreNavState(NAV_STATE_KEYS, content);
      remount();
    } catch {
      state = "idle";
      if (fallbackHref && isOpen()) window.location.assign(fallbackHref);
    } finally {
      content.removeAttribute("aria-busy");
    }
  }

  const prefetch = () => void fetchFragment(src).catch(() => {});
  const observer = new MutationObserver(() => {
    let idle = 0;
  if (opts.loaded) {
    const warm = () => void fetchFragment(src).catch(() => {});
    idle = window.requestIdleCallback
      ? window.requestIdleCallback(warm, { timeout: 5000 })
      : window.setTimeout(warm, 2000);
  } else if (isOpen()) void load();
  });
  observer.observe(trigger, { attributes: true, attributeFilter: ["data-nb-state"] });
  trigger.addEventListener("pointerenter", prefetch);
  trigger.addEventListener("focus", prefetch);
  trigger.addEventListener("touchstart", prefetch, { passive: true });

  let idle = 0;
  if (opts.loaded) {
    const warm = () => void fetchFragment(src).catch(() => {});
    idle = window.requestIdleCallback
      ? window.requestIdleCallback(warm, { timeout: 5000 })
      : window.setTimeout(warm, 2000);
  } else if (isOpen()) void load();

  return {
    load,
    destroy() {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      observer.disconnect();
      trigger.removeEventListener("pointerenter", prefetch);
      trigger.removeEventListener("focus", prefetch);
      trigger.removeEventListener("touchstart", prefetch);
    },
  };
}
