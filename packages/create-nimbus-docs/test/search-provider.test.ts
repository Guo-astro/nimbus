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
  __searchIndex?: { bundle: string; merge: string[] };
  __BASE_URL?: string;
  __import?: (href: string) => Promise<unknown>;
  window?: unknown;
};

const WHOLE_SITE = { bundle: "/pagefind/", merge: [] };

// Runs the starter's provider outside Vite: its build-time inputs (the
// Nimbus config, the search index record and `import.meta.env.BASE_URL`) and
// the dynamic import of Pagefind become globals, so the test sees the URLs
// search would load and merge.
async function pagefindUrlFor(
  base: string,
  searchIndex: { bundle: string; merge: string[] } = WHOLE_SITE,
): Promise<{ loaded: string; merged: string[]; baseUrls: string[] }> {
  const source = fs
    .readFileSync(PROVIDER, "utf8")
    .replace(
      /import \{[^}]*\} from "virtual:nimbus\/config";/,
      "const config = (globalThis as any).__config; const searchIndex = (globalThis as any).__searchIndex;",
    )
    .replaceAll("import.meta.env.BASE_URL", "(globalThis as any).__BASE_URL")
    .replace(/await import\(\/\* @vite-ignore \*\/ ([^)]+)\)/, "await (globalThis as any).__import($1)");
  assert.match(source, /__import\(/, "the provider still loads Pagefind with a dynamic import");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-search-"));
  const file = path.join(dir, "pagefind.ts");
  fs.writeFileSync(file, source);
  const globals = globalThis as Globals;
  let loaded = "";
  const merged: string[] = [];
  const baseUrls: string[] = [];
  Object.assign(globals, {
    __config: {},
    __searchIndex: searchIndex,
    __BASE_URL: base,
    __import: async (href: string) => {
      loaded = href;
      return {
        init: async () => {},
        options: async (options: { baseUrl?: string }) => {
          if (options.baseUrl) baseUrls.push(options.baseUrl);
        },
        mergeIndex: async (href: string, options?: { baseUrl?: string }) => {
          merged.push(href);
          if (options?.baseUrl) baseUrls.push(options.baseUrl);
        },
        search: async () => ({ results: [] }),
      };
    },
    window: { location: { origin: "https://example.com" } },
  });
  try {
    const { provider } = (await import(pathToFileURL(file).href)) as { provider: { init(): Promise<void> } };
    await provider.init();
    return { loaded, merged, baseUrls };
  } finally {
    delete globals.__config;
    delete globals.__searchIndex;
    delete globals.__BASE_URL;
    delete globals.__import;
    delete globals.window;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("search loads Pagefind below the site's base, with or without a trailing slash", async () => {
  assert.equal((await pagefindUrlFor("/")).loaded, "https://example.com/pagefind/pagefind.js");
  assert.equal((await pagefindUrlFor("/docs")).loaded, "https://example.com/docs/pagefind/pagefind.js");
  assert.equal((await pagefindUrlFor("/docs/")).loaded, "https://example.com/docs/pagefind/pagefind.js");
  assert.deepEqual((await pagefindUrlFor("/")).merged, [], "a whole-site build merges nothing");
  assert.deepEqual((await pagefindUrlFor("/docs/")).baseUrls, ["/docs/"], "result URLs resolve under the base");
});


test("a slice build loads its own bundle and merges the other slices' bundles", async () => {
  const { loaded, merged } = await pagefindUrlFor("/", {
    bundle: "/docs-es/pagefind/",
    merge: ["/pagefind/", "/api/pagefind/"],
  });
  assert.equal(loaded, "https://example.com/docs-es/pagefind/pagefind.js");
  assert.deepEqual(merged, ["https://example.com/pagefind/", "https://example.com/api/pagefind/"]);
});

test("a slice's results resolve from the site root, not from under the slice's bundle", async () => {
  const { baseUrls } = await pagefindUrlFor("/", { bundle: "/docs-es/pagefind/", merge: ["/pagefind/"] });
  assert.deepEqual(baseUrls, ["/", "/"], "the slice's own index and the merged one both resolve at /");
});
