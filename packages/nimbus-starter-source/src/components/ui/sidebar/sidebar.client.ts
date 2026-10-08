/** Sidebar runtime: filter, persistence, "/" shortcut.
 *
 * Groups are native `<details data-nb-sidebar-group>`: open state is the
 * element's own `open` property, and changes arrive as `toggle` events
 * (captured on the root — `toggle` doesn't bubble). No click simulation.
 */

import { mount } from "@cloudflare/nimbus-docs/client";

const STORAGE_KEY = "sidebar-state";

interface SidebarState {
  hash: string;
  open: boolean[];
  scroll: number;
}

function groupsOf(root: HTMLElement): HTMLDetailsElement[] {
  return Array.from(
    root.querySelectorAll<HTMLDetailsElement>("details[data-nb-sidebar-group]"),
  );
}

function initSidebar(root: HTMLElement): () => void {
  const teardowns: Array<() => void> = [];
  const persist = root.hasAttribute("data-nb-sidebar-persist");

  const filterTeardown = initFilter(root);
  if (filterTeardown) teardowns.push(filterTeardown);

  if (persist) {
    const persistTeardown = initPersistence(root);
    if (persistTeardown) teardowns.push(persistTeardown);
  }

  return () => teardowns.forEach((t) => t());
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

function initFilter(root: HTMLElement): (() => void) | null {
  const input = root.querySelector<HTMLInputElement>("[data-nb-sidebar-filter-input]");
  // SidebarFilter is rendered *next to* Sidebar (sibling), so also look in
  // the parent — preserves the existing layout where filter sits above.
  const inputElement =
    input ?? root.parentElement?.querySelector<HTMLInputElement>("[data-nb-sidebar-filter-input]") ?? null;
  if (!inputElement) return null;

  function handleInput() {
    const query = inputElement!.value.trim().toLowerCase();
    if (!query) {
      resetFilter(root);
      return;
    }
    applyFilter(root, query);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      inputElement!.value = "";
      handleInput();
      inputElement!.blur();
    }
  }

  inputElement.addEventListener("input", handleInput);
  inputElement.addEventListener("keydown", handleKeydown);

  return () => {
    inputElement.removeEventListener("input", handleInput);
    inputElement.removeEventListener("keydown", handleKeydown);
    resetFilter(root);
  };
}

function resetFilter(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-nb-sidebar-hidden]").forEach((el) => {
    el.removeAttribute("data-nb-sidebar-hidden");
  });
  // Close groups the filter opened, restoring the reader's previous state.
  root
    .querySelectorAll<HTMLDetailsElement>("[data-nb-sidebar-group][data-nb-opened-by-filter]")
    .forEach((group) => {
      group.open = false;
      group.removeAttribute("data-nb-opened-by-filter");
    });
}

function applyFilter(root: HTMLElement, query: string): void {
  const links = root.querySelectorAll<HTMLElement>("[data-nb-sidebar-link]");
  const groups = root.querySelectorAll<HTMLElement>("[data-nb-sidebar-group]");

  links.forEach((link) => link.setAttribute("data-nb-sidebar-hidden", ""));
  groups.forEach((group) => group.setAttribute("data-nb-sidebar-hidden", ""));

  links.forEach((link) => {
    const text = link.textContent?.toLowerCase() ?? "";
    if (!text.includes(query)) return;
    link.removeAttribute("data-nb-sidebar-hidden");
    revealAncestors(link, root);
  });

  groups.forEach((group) => {
    const label = group.querySelector("[data-nb-sidebar-group-label]");
    const text = label?.textContent?.toLowerCase() ?? "";
    if (!text.includes(query)) return;
    group.removeAttribute("data-nb-sidebar-hidden");
    openGroup(group);
    group.querySelectorAll<HTMLElement>("[data-nb-sidebar-link], [data-nb-sidebar-group]")
      .forEach((child) => child.removeAttribute("data-nb-sidebar-hidden"));
  });
}

function revealAncestors(el: HTMLElement, scope: Element): void {
  let parent: HTMLElement | null = el.parentElement;
  while (parent && parent !== scope) {
    if (parent.hasAttribute("data-nb-sidebar-group")) {
      parent.removeAttribute("data-nb-sidebar-hidden");
      openGroup(parent);
    }
    parent = parent.parentElement;
  }
}

function openGroup(group: HTMLElement): void {
  if (!(group instanceof HTMLDetailsElement) || group.open) return;
  group.setAttribute("data-nb-opened-by-filter", "");
  group.open = true;
}

// ---------------------------------------------------------------------------
// Persistence (open state + scroll)
// ---------------------------------------------------------------------------

function initPersistence(root: HTMLElement): (() => void) | null {
  // The scrollable container: the movable tree wrapper (shared between the
  // desktop rail and the drawer), the enclosing <aside>, or the root itself.
  const scrollHost: HTMLElement =
    root.closest<HTMLElement>("[data-nb-sidebar-tree]") ?? root.closest("aside") ?? root;
  const hash = root.dataset.nbSidebarHash ?? "";

  function readState(): SidebarState {
    return {
      hash,
      open: groupsOf(root).map((group) => group.open),
      scroll: scrollHost.scrollTop,
    };
  }

  function save() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(readState()));
    } catch {}
  }

  // `toggle` doesn't bubble; capture on the root observes every group. A
  // group the filter opened is transient state and not saved.
  const handleToggle = (event: Event) => {
    const group = event.target as HTMLElement | null;
    if (!group?.matches?.("[data-nb-sidebar-group]")) return;
    if (group.hasAttribute("data-nb-opened-by-filter")) return;
    save();
  };
  root.addEventListener("toggle", handleToggle, true);

  function handleVisibility() {
    if (document.visibilityState === "hidden") save();
  }
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", save);

  let raf = 0;
  function handleScroll() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(save);
  }
  scrollHost.addEventListener("scroll", handleScroll);

  return () => {
    root.removeEventListener("toggle", handleToggle, true);
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("pagehide", save);
    scrollHost.removeEventListener("scroll", handleScroll);
    cancelAnimationFrame(raf);
  };
}

// ---------------------------------------------------------------------------
// Global `/` shortcut — bound once at module load
// ---------------------------------------------------------------------------

(function bindFilterShortcut() {
  if (document.documentElement.hasAttribute("data-nb-sidebar-shortcut-bound")) return;
  document.documentElement.setAttribute("data-nb-sidebar-shortcut-bound", "");

  document.addEventListener("keydown", (e) => {
    if (e.key !== "/") return;
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable)
    ) {
      return;
    }
    // One tree per page now: the filter input travels with it between the
    // rail and the drawer, so take the first visible input.
    const input = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-nb-sidebar-filter-input]"),
    ).find((candidate) => candidate.offsetParent !== null);
    if (!input) return;
    e.preventDefault();
    input.focus();
  });
})();

mount("[data-nb-sidebar]", initSidebar);
