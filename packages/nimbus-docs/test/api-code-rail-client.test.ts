/**
 * Tests for the starter's API code rail client (`code-rail.client.ts`): the
 * reader picks one sample on a page by id, while the choice that follows them
 * to other operations and tabs is the sample's language. Navigation is
 * simulated with Astro's `astro:before-swap` and `astro:page-load` events,
 * which `mount` listens for.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { JSDOM } from "jsdom";

const SYNC_KEY = "nb-api-code-rail__lang";

let dom: JSDOM;

before(async () => {
  dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://x.dev/start" });
  const g = globalThis as any;
  for (const key of ["window", "document", "localStorage", "location", "history"]) {
    g[key] = (dom.window as any)[key];
  }
  for (const key of ["HTMLElement", "HTMLSelectElement", "Event", "CustomEvent", "StorageEvent"]) {
    g[key] = (dom.window as any)[key];
  }
  await import("../../nimbus-starter-source/src/components/ui/api-code-rail/code-rail.client.ts");
});

function rail(samples: Array<[id: string, lang: string]>): string {
  const options = samples.map(([id], i) => `<option value="${id}"${i === 0 ? " selected" : ""}>${id}</option>`);
  const panels = samples.map(
    ([id, lang], i) =>
      `<div data-nb-lang-panel data-nb-lang-value="${id}" data-nb-sample-lang="${lang}"${i === 0 ? "" : " hidden"}>${id}</div>`,
  );
  return `<div data-nb-lang-picker><select data-nb-lang-select>${options.join("")}</select>${panels.join("")}</div>`;
}

// Swap the page the way Astro's client router does.
function navigate(url: string, samples: Array<[string, string]>): void {
  document.dispatchEvent(new dom.window.Event("astro:before-swap"));
  history.replaceState(null, "", url);
  document.body.innerHTML = rail(samples);
  document.dispatchEvent(new dom.window.Event("astro:page-load"));
}

function visible(): string {
  const shown = [...document.querySelectorAll<HTMLElement>("[data-nb-lang-panel]")].filter((p) => !p.hidden);
  assert.equal(shown.length, 1, "exactly one sample is visible");
  const select = document.querySelector<HTMLSelectElement>("[data-nb-lang-select]")!;
  assert.equal(select.value, shown[0]!.dataset.nbLangValue, "the picker matches the visible sample");
  return shown[0]!.dataset.nbLangValue!;
}

function choose(id: string): void {
  const select = document.querySelector<HTMLSelectElement>("[data-nb-lang-select]")!;
  select.value = id;
  select.dispatchEvent(new dom.window.Event("change"));
}

const SDK_AND_REQUESTS: Array<[string, string]> = [
  ["curl", "curl"],
  ["python", "python"],
  ["python-2", "python"],
];
const DEFAULT_THREE: Array<[string, string]> = [
  ["curl", "curl"],
  ["typescript", "typescript"],
  ["python", "python"],
];

test("choosing a second sample saves its language, and another operation opens that language", () => {
  localStorage.clear();
  navigate("https://x.dev/a", SDK_AND_REQUESTS);
  assert.equal(visible(), "curl");

  choose("python-2");
  assert.equal(visible(), "python-2");
  assert.equal(localStorage.getItem(SYNC_KEY), "python");
  assert.equal(new URL(location.href).searchParams.get("lang"), "python-2");

  navigate("https://x.dev/b", DEFAULT_THREE);
  assert.equal(visible(), "python");
});

test("?lang= opens an exact sample id first, else the language's first sample", () => {
  localStorage.clear();
  navigate("https://x.dev/a?lang=python-2", SDK_AND_REQUESTS);
  assert.equal(visible(), "python-2");
  navigate("https://x.dev/a?lang=python", SDK_AND_REQUESTS);
  assert.equal(visible(), "python");
  navigate("https://x.dev/b?lang=curl", DEFAULT_THREE);
  assert.equal(visible(), "curl");
  navigate("https://x.dev/b?lang=nope", DEFAULT_THREE);
  assert.equal(visible(), "curl", "an unknown value keeps the server default");
});

test("a link matching no sample id or language falls back to the saved language", () => {
  localStorage.setItem(SYNC_KEY, "typescript");
  // No `python-2` sample here, and `python-2` is not a language on this page.
  navigate("https://x.dev/b?lang=python-2", DEFAULT_THREE);
  assert.equal(visible(), "typescript");
  navigate("https://x.dev/b", DEFAULT_THREE);
  assert.equal(visible(), "typescript");
});

test("another tab's language choice switches the rail, keeping a sample already in that language", () => {
  localStorage.clear();
  navigate("https://x.dev/a", SDK_AND_REQUESTS);
  choose("python-2");

  const fromOtherTab = (value: string) =>
    window.dispatchEvent(new dom.window.StorageEvent("storage", { key: SYNC_KEY, newValue: value }));
  fromOtherTab("python");
  assert.equal(visible(), "python-2", "already showing a Python sample");
  fromOtherTab("curl");
  assert.equal(visible(), "curl");
});
