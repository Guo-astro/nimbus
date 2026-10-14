import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const PROVIDER = path.resolve(
  import.meta.dirname,
  "../../nimbus-starter-source/src/components/ui/search/providers/pagefind.ts",
);

type Globals = {
  __config?: unknown;
  __BASE_URL?: string;
  __import?: (href: string) => Promise<unknown>;
  window?: unknown;
};

// Runs the starter's provider outside Vite: its two build-time inputs (the
// Nimbus config and `import.meta.env.BASE_URL`) and the dynamic import of
// Pagefind become globals, so the test sees the URL search would load.
async function pagefindUrlFor(base: string): Promise<string> {
  const source = fs
    .readFileSync(PROVIDER, "utf8")
    .replace('import { config } from "virtual:nimbus/config";', "const config = (globalThis as any).__config;")
    .replaceAll("import.meta.env.BASE_URL", "(globalThis as any).__BASE_URL")
    .replace(/await import\(\/\* @vite-ignore \*\/ ([^)]+)\)/, "await (globalThis as any).__import($1)");
  assert.match(source, /__import\(/, "the provider still loads Pagefind with a dynamic import");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-search-"));
  const file = path.join(dir, "pagefind.ts");
  fs.writeFileSync(file, source);
  const globals = globalThis as Globals;
  let loaded = "";
  Object.assign(globals, {
    __config: {},
    __BASE_URL: base,
    __import: async (href: string) => {
      loaded = href;
      return { init: async () => {}, search: async () => ({ results: [] }) };
    },
    window: { location: { origin: "https://example.com" } },
  });
  try {
    const { provider } = (await import(pathToFileURL(file).href)) as { provider: { init(): Promise<void> } };
    await provider.init();
    return loaded;
  } finally {
    delete globals.__config;
    delete globals.__BASE_URL;
    delete globals.__import;
    delete globals.window;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("search loads Pagefind below the site's base, with or without a trailing slash", async () => {
  assert.equal(await pagefindUrlFor("/"), "https://example.com/pagefind/pagefind.js");
  assert.equal(await pagefindUrlFor("/docs"), "https://example.com/docs/pagefind/pagefind.js");
  assert.equal(await pagefindUrlFor("/docs/"), "https://example.com/docs/pagefind/pagefind.js");
});
