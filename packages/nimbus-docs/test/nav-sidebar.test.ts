/**
 * `client/nav-sidebar.ts`: the restore script and `initNavSidebar`, against
 * the markup contract `ApiSidebarItem` renders.
 */

import assert from "node:assert/strict";
import { beforeEach, before, describe, test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

import {
  NAV_STATE_KEYS,
  initNavSidebar,
  restoreNavState,
} from "../src/client/nav-sidebar.js";

const navigations: string[] = [];
let fetches: string[] = [];
let respond: (src: string) => Promise<Response> = () => Promise.reject(new Error("offline"));

before(() => {
  const virtualConsole = new VirtualConsole();
  // jsdom cannot navigate; it reports the attempt, which is what we assert on.
  virtualConsole.on("jsdomError", (error) => {
    if (/navigation/i.test(error.message)) navigations.push(error.message);
  });
  const dom = new JSDOM("<!DOCTYPE html><body></body>", {
    url: "https://example.test/api/",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const g = globalThis as any;
  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "SVGElement",
    "Element",
    "MutationObserver",
    "DOMParser",
    "sessionStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "Event",
  ]) {
    g[name] = name === "window" ? dom.window : (dom.window as any)[name];
  }
  g.fetch = (src: string) => {
    fetches.push(new URL(src).pathname);
    return respond(src);
  };
});

beforeEach(() => {
  sessionStorage.clear();
  navigations.length = 0;
  fetches = [];
  respond = () => Promise.reject(new Error("offline"));
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const group = (id: string, opts: { src?: string; open?: boolean; rows?: string } = {}) => `
  <div data-nb-collapsible data-nb-nav-group='${id}'${opts.src ? ` data-nb-nav-src="${opts.src}"` : ""}>
    <div data-header><a href="${opts.src ?? "#"}">${id}</a><button data-nb-collapsible-trigger data-nb-state="${opts.open ? "open" : "closed"}"></button></div>
    <div data-nb-collapsible-content data-nb-state="${opts.open ? "open" : "closed"}"><div class="wrap">${opts.rows ?? ""}</div></div>
  </div>`;

/** A page with one sidebar, rendered by build `build`: a collapsed group and
 *  the current page's trail. */
function page(src = "/api/a/", build = "b1") {
  document.body.innerHTML = `
    <aside data-nb-nav-state="k" data-nb-nav-build="${build}" data-nb-nav-scroller="desktop">
      ${group("tags.A", { src })}
      ${group("tags.T", { open: true, rows: `<ul><li><a aria-current="page" href="/api/t/x/">Current</a></li></ul>` })}
    </aside>`;
  return document.querySelector<HTMLElement>("[data-nb-nav-state]")!;
}
const panel = (id: string) =>
  document.querySelector(`[data-nb-nav-group='${id}'] [data-nb-collapsible-content]`)!;
const trigger = (id: string) =>
  document.querySelector<HTMLElement>(`[data-nb-nav-group='${id}'] [data-nb-collapsible-trigger]`)!;
const saved = () => JSON.parse(sessionStorage.getItem(`${NAV_STATE_KEYS.state}k`) ?? "{}");
const cacheRows = (build: string, rows: Record<string, string>) =>
  sessionStorage.setItem(NAV_STATE_KEYS.rows, JSON.stringify({ build, rows }));
/** A fetched page, rendered by build `build`. */
const html = (body: string, build = "b1") =>
  Promise.resolve(
    new Response(`<!DOCTYPE html><body><aside data-nb-nav-build="${build}">${body}</aside></body>`, { status: 200 }),
  );

describe("restoreNavState", () => {
  test("reopens remembered groups, fills only collapsed ones, and keeps the trail's highlight", () => {
    page();
    sessionStorage.setItem(`${NAV_STATE_KEYS.state}k`, JSON.stringify({ open: ["tags.A", "tags.T"] }));
    cacheRows("b1", {
      "/api/a/ tags.A": `<div class="wrap"><ul><li>Cached A</li></ul></div>`,
      "undefined tags.T": "<ul><li>Stale T</li></ul>",
      "null tags.T": "<ul><li>Stale T</li></ul>",
    });
    restoreNavState(NAV_STATE_KEYS);
    assert.equal(trigger("tags.A").getAttribute("data-nb-state"), "open");
    assert.equal(panel("tags.A").textContent, "Cached A");
    assert.ok(panel("tags.A").querySelector(":scope > .wrap > ul"), "the panel keeps one wrapper");
    assert.equal(document.querySelector("[data-nb-nav-group='tags.A']")!.hasAttribute("data-nb-nav-src"), false);
    assert.ok(panel("tags.T").querySelector("[aria-current='page']"), "trail rows untouched");
  });

  test("ignores rows cached by another build, and caches nothing in dev", () => {
    for (const build of ["b2", ""]) {
      page("/api/a/", build);
      sessionStorage.setItem(`${NAV_STATE_KEYS.state}k`, JSON.stringify({ open: ["tags.A"] }));
      cacheRows("b1", { "/api/a/ tags.A": "<ul><li>Old</li></ul>" });
      restoreNavState(NAV_STATE_KEYS);
      assert.equal(trigger("tags.A").getAttribute("data-nb-state"), "open");
      assert.equal(panel("tags.A").textContent, "", `build "${build}"`);
    }
  });

  test("restores each container once", () => {
    page();
    sessionStorage.setItem(`${NAV_STATE_KEYS.state}k`, JSON.stringify({ open: ["tags.A"] }));
    restoreNavState(NAV_STATE_KEYS);
    trigger("tags.A").setAttribute("data-nb-state", "closed");
    restoreNavState(NAV_STATE_KEYS);
    assert.equal(trigger("tags.A").getAttribute("data-nb-state"), "closed", "not restored twice");
  });

  // After a view-transition swap, the swap listener registered by the first
  // page restores the new markup before that page's own script runs. It must
  // judge cached rows by the new markup's build, not the first page's.
  test("after a swap, judges cached rows by the new page's build", () => {
    page("/api/a/", "old");
    sessionStorage.setItem(`${NAV_STATE_KEYS.state}k`, JSON.stringify({ open: ["tags.A"] }));
    restoreNavState(NAV_STATE_KEYS); // binds the swap listener (once per window)
    cacheRows("old", { "/api/a/ tags.A": "<ul><li>Old row</li></ul>" });
    page("/api/a/", "new"); // the deploy, then a client-side navigation
    document.dispatchEvent(new window.Event("astro:after-swap"));
    assert.equal(trigger("tags.A").getAttribute("data-nb-state"), "open");
    assert.equal(panel("tags.A").textContent, "", "old build's rows not shown");
    assert.ok(document.querySelector("[data-nb-nav-group='tags.A'][data-nb-nav-src]"), "still loads");

    cacheRows("new", { "/api/a/ tags.A": "<ul><li>New row</li></ul>" });
    page("/api/a/", "new");
    document.dispatchEvent(new window.Event("astro:after-swap"));
    assert.equal(panel("tags.A").textContent, "New row");
  });
});

describe("initNavSidebar", () => {
  test("saves the groups the reader toggles, not the page's own trail", async () => {
    const root = page("/api/save/");
    const stop = initNavSidebar(root);
    await settle();
    assert.deepEqual(saved().open ?? [], [], "trail not saved");
    trigger("tags.T").setAttribute("data-nb-state", "closed");
    await settle();
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.deepEqual(saved().open, ["tags.A"]);
    stop();
  });

  test("loads a group's rows from its page by exact coordinate, and caches them", async () => {
    const root = page("/api/load/");
    respond = () =>
      html(`
        ${group(`tags.A"x`, { open: true, rows: "<ul><li>Wrong group</li></ul>" })}
        ${group("tags.A", { open: true, rows: "<ul><li>Loaded A</li></ul><script>window.ran = true</script>" })}`);
    const stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.equal(panel("tags.A").textContent, "Loaded A");
    assert.equal(panel("tags.A").querySelector("script"), null, "scripts stripped");
    assert.ok(panel("tags.A").querySelector(":scope > .wrap > ul"), "the panel keeps one wrapper");
    const cache = JSON.parse(sessionStorage.getItem(NAV_STATE_KEYS.rows)!);
    assert.equal(cache.build, "b1");
    assert.match(cache.rows["/api/load/ tags.A"], /Loaded A/);
    stop();
  });

  test("on failure, follows the link only when the reader opened the group", async () => {
    sessionStorage.setItem(`${NAV_STATE_KEYS.state}k`, JSON.stringify({ open: ["tags.A"] }));
    let root = page("/api/fail-restored/");
    restoreNavState(NAV_STATE_KEYS);
    let stop = initNavSidebar(root);
    await settle();
    assert.equal(navigations.length, 0, "restored open: stays on the page");
    stop();

    sessionStorage.clear();
    root = page("/api/fail-opened/");
    stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.equal(navigations.length, 1, "reader opened it: goes to its page");
    stop();
  });

  test("does nothing once torn down", async () => {
    const root = page("/api/late/");
    let release!: () => void;
    respond = () => new Promise((resolve) => (release = () => resolve(new Response("", { status: 500 }))));
    const stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    stop();
    release();
    await settle();
    assert.equal(navigations.length, 0);
  });

  test("prefetches on intent once per page, never for the trail or for rows", async () => {
    const root = page("/api/hover/");
    respond = () => html(group("tags.A", { open: true, rows: "<ul><li>A</li></ul>" }));
    const stop = initNavSidebar(root);
    const over = (el: Element) => el.dispatchEvent(new window.Event("pointerover", { bubbles: true }));
    over(document.querySelector("[data-nb-nav-group='tags.A'] a")!);
    over(document.querySelector("[data-nb-nav-group='tags.A'] a")!);
    over(panel("tags.T").querySelector("a")!);
    await settle();
    assert.deepEqual(fetches, ["/api/hover/"]);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.deepEqual(fetches, ["/api/hover/"], "opening reuses the prefetch");
    assert.equal(panel("tags.A").textContent, "A");
    stop();
  });

  test("never fetches or follows a source outside this site", async () => {
    for (const src of ["javascript:alert(1)", "https://evil.test/api/a/", "//evil.test/x/"]) {
      sessionStorage.clear();
      const root = page(src);
      const stop = initNavSidebar(root);
      document.querySelector("[data-nb-nav-group='tags.A'] a")!
        .dispatchEvent(new window.Event("pointerover", { bubbles: true }));
      trigger("tags.A").setAttribute("data-nb-state", "open");
      await settle();
      assert.deepEqual(fetches, [], src);
      assert.equal(navigations.length, 0, src);
      stop();
    }
  });

  test("never inserts rows a redirect brought from another site", async () => {
    const offsite = async (url: string) => {
      const response = await html(group("tags.A", { open: true, rows: "<ul><li>Off-site</li></ul>" }));
      return Object.defineProperties(response, { redirected: { value: true }, url: { value: url } });
    };
    respond = () => offsite("https://evil.test/api/a/");
    let root = page("/api/redirected-off/");
    let stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.equal(panel("tags.A").textContent, "", "rows not inserted");
    assert.equal(sessionStorage.getItem(NAV_STATE_KEYS.rows), null, "nor cached");
    assert.equal(navigations.length, 1, "the reader goes to the group's page instead");
    stop();

    // A same-site redirect (a trailing slash, a moved page) still loads.
    respond = () => offsite("https://example.test/api/moved/");
    root = page("/api/redirected-here/");
    stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.equal(panel("tags.A").textContent, "Off-site");
    stop();
  });

  test("the drawer's explicit scroll-only restore leaves groups alone", async () => {
    // One tree per page now: nothing watches for a container becoming
    // visible. The drawer calls the shared restore itself when it reveals
    // the node, scroll-only — opening groups there would bypass the mounted
    // disclosure, whose own state would then disagree with the markup.
    const root = page("/api/shown-later/");
    let height = 0;
    Object.defineProperty(root, "clientHeight", { get: () => height });
    const stop = initNavSidebar(root);
    sessionStorage.setItem(
      `${NAV_STATE_KEYS.state}k`,
      JSON.stringify({ open: ["tags.A"], scroll: { desktop: 120 } }),
    );
    height = 400;
    restoreNavState(NAV_STATE_KEYS, root, true);
    await settle();
    assert.equal(trigger("tags.A").getAttribute("data-nb-state"), "closed");
    assert.deepEqual(fetches, [], "and nothing loads as if the reader opened it");
    assert.equal(navigations.length, 0);
    assert.equal(root.scrollTop, 120);
    stop();
  });

  test("a deploy mid-session: no old pages from memory, no rows cached across builds", async () => {
    respond = () => html(group("tags.A", { open: true, rows: "<ul><li>Old build</li></ul>" }), "old");
    let root = page("/api/deploy/", "old");
    let stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.equal(panel("tags.A").textContent, "Old build");
    stop();

    // The next page comes from the new build; the module (and its memory) lives on.
    respond = () => html(group("tags.A", { open: true, rows: "<ul><li>New build</li></ul>" }), "new");
    sessionStorage.removeItem(NAV_STATE_KEYS.rows);
    root = page("/api/deploy/", "new");
    stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.equal(panel("tags.A").textContent, "New build", "fetched again, not from memory");
    stop();

    // A cache served the old build's page: ask once more, bypassing caches.
    let calls = 0;
    respond = () =>
      calls++ === 0
        ? html(group("tags.A", { open: true, rows: "<ul><li>Cached old copy</li></ul>" }), "old")
        : html(group("tags.A", { open: true, rows: "<ul><li>Fresh</li></ul>" }), "new");
    root = page("/api/deploy-cached/", "new");
    stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.equal(panel("tags.A").textContent, "Fresh");
    assert.equal(calls, 2);
    stop();

    // Still from another build (a stale edge): shown, but not cached as this build's.
    respond = () => html(group("tags.A", { open: true, rows: "<ul><li>Stale edge copy</li></ul>" }), "old");
    sessionStorage.removeItem(NAV_STATE_KEYS.rows);
    root = page("/api/deploy-stale/", "new");
    stop = initNavSidebar(root);
    trigger("tags.A").setAttribute("data-nb-state", "open");
    await settle();
    assert.equal(panel("tags.A").textContent, "Stale edge copy");
    assert.equal(sessionStorage.getItem(NAV_STATE_KEYS.rows), null);
    stop();
  });
});

// ---------------------------------------------------------------------------
// Native <details> markup (the current starter): same storage format, same
// behavior, driven by the element's own `open` and `toggle` events.
// ---------------------------------------------------------------------------

describe("native <details> markup", () => {
  beforeEach(() => {
    sessionStorage.clear();
    fetches.length = 0;
    navigations.length = 0;
  });

  const detailsGroup = (
    id: string,
    options: { src?: string; open?: boolean; rows?: string } = {},
  ) => `
    <details data-nb-nav-group="${id}"${options.src ? ` data-nb-nav-src="${options.src}"` : ""}${options.open ? " open" : ""}>
      <summary data-nb-sidebar-group-label>${id}</summary>
      <ul>${options.rows ?? ""}</ul>
    </details>`;

  const detailsPage = (src = "/api/a/", build = "b1") => {
    document.body.innerHTML = `
      <aside data-nb-nav-state="k" data-nb-nav-build="${build}" data-nb-nav-scroller="desktop">
        ${detailsGroup("tags.A", { src })}
        ${detailsGroup("tags.T", { open: true, rows: `<li><a aria-current="page" href="/api/t/x/">Current</a></li>` })}
      </aside>`;
    return document.querySelector<HTMLElement>("[data-nb-nav-state]")!;
  };
  const details = (id: string) =>
    document.querySelector<HTMLDetailsElement>(`details[data-nb-nav-group='${id}']`)!;
  const listOf = (id: string) => details(id).querySelector("ul")!;

  test("restore opens remembered details and fills cached rows into the list", () => {
    detailsPage();
    sessionStorage.setItem(
      `${NAV_STATE_KEYS.state}k`,
      JSON.stringify({ open: ["tags.A", "tags.T"] }),
    );
    cacheRows("b1", { "/api/a/ tags.A": "<li><a href='/api/a/one/'>One</a></li>" });
    restoreNavState(NAV_STATE_KEYS);
    assert.equal(details("tags.A").open, true);
    assert.equal(details("tags.T").open, true);
    assert.match(listOf("tags.A").innerHTML, /One/);
    assert.equal(details("tags.A").hasAttribute("data-nb-nav-src"), false);
    // The server-rendered trail keeps its rows (and highlight).
    assert.match(listOf("tags.T").innerHTML, /aria-current="page"/);
  });

  test("a toggle records the change and loads a deferred group's rows", async () => {
    respond = () =>
      Promise.resolve(
        new Response(
          `<!DOCTYPE html><body><aside data-nb-nav-build="b1">${detailsGroup("tags.A", { rows: "<li><a href='/api/a/one/'>One</a></li>" })}</aside></body>`,
          { status: 200 },
        ),
      );
    const root = detailsPage();
    const stop = initNavSidebar(root);
    const group = details("tags.A");
    group.open = true;
    group.dispatchEvent(new window.Event("toggle"));
    await settle();
    assert.deepEqual(saved().open, ["tags.A"]);
    assert.match(listOf("tags.A").innerHTML, /One/);
    assert.equal(group.hasAttribute("data-nb-nav-src"), false);
    // Closing removes it from the saved set.
    group.open = false;
    group.dispatchEvent(new window.Event("toggle"));
    await settle();
    assert.deepEqual(saved().open, []);
    stop();
  });
});
