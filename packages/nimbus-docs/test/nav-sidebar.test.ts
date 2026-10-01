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
    fetches.push(src);
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

/** A page with one sidebar: a collapsed group and the current page's trail. */
function page(src = "/api/a/") {
  document.body.innerHTML = `
    <aside data-nb-nav-state="k" data-nb-nav-scroller="desktop">
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
const config = (build: string) => ({ ...NAV_STATE_KEYS, build });
const cacheRows = (build: string, rows: Record<string, string>) =>
  sessionStorage.setItem(NAV_STATE_KEYS.rows, JSON.stringify({ build, rows }));
const html = (body: string) =>
  Promise.resolve(new Response(`<!DOCTYPE html><body>${body}</body>`, { status: 200 }));

describe("restoreNavState", () => {
  test("reopens remembered groups, fills only collapsed ones, and keeps the trail's highlight", () => {
    page();
    sessionStorage.setItem(`${NAV_STATE_KEYS.state}k`, JSON.stringify({ open: ["tags.A", "tags.T"] }));
    cacheRows("b1", {
      "/api/a/ tags.A": `<div class="wrap"><ul><li>Cached A</li></ul></div>`,
      "undefined tags.T": "<ul><li>Stale T</li></ul>",
      "null tags.T": "<ul><li>Stale T</li></ul>",
    });
    restoreNavState(config("b1"));
    assert.equal(trigger("tags.A").getAttribute("data-nb-state"), "open");
    assert.equal(panel("tags.A").textContent, "Cached A");
    assert.ok(panel("tags.A").querySelector(":scope > .wrap > ul"), "the panel keeps one wrapper");
    assert.equal(document.querySelector("[data-nb-nav-group='tags.A']")!.hasAttribute("data-nb-nav-src"), false);
    assert.ok(panel("tags.T").querySelector("[aria-current='page']"), "trail rows untouched");
  });

  test("ignores rows cached by another build, and caches nothing in dev", () => {
    for (const build of ["b2", ""]) {
      page();
      sessionStorage.setItem(`${NAV_STATE_KEYS.state}k`, JSON.stringify({ open: ["tags.A"] }));
      cacheRows("b1", { "/api/a/ tags.A": "<ul><li>Old</li></ul>" });
      restoreNavState(config(build));
      assert.equal(trigger("tags.A").getAttribute("data-nb-state"), "open");
      assert.equal(panel("tags.A").textContent, "", `build "${build}"`);
    }
  });

  test("restores each container once, and stamps the page's build id", () => {
    const root = page();
    sessionStorage.setItem(`${NAV_STATE_KEYS.state}k`, JSON.stringify({ open: ["tags.A"] }));
    restoreNavState(config("old"));
    trigger("tags.A").setAttribute("data-nb-state", "closed");
    restoreNavState(config("new"));
    assert.equal(trigger("tags.A").getAttribute("data-nb-state"), "closed", "not restored twice");
    assert.equal(root.getAttribute("data-nb-nav-restored"), "new");
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
    root.setAttribute("data-nb-nav-restored", "b1");
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
    restoreNavState(config("b1"));
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
});
