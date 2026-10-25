// Placing nested collections costs one entry read per collection on a cold
// structural build and none on warm `getSidebar` calls.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const entries: Record<string, Array<{ id: string; data: { title: string } }>> = {
  docs: [{ id: "products/intro", data: { title: "Intro" } }, { id: "integrations/kafka", data: { title: "Kafka" } }],
  sdk: [{ id: "index", data: { title: "SDK" } }, { id: "setup", data: { title: "Setup" } }],
  cli: [{ id: "run", data: { title: "Run" } }],
  guide: [{ id: "start", data: { title: "Start" } }],
};
const reads: string[] = [];
Object.assign(globalThis, { __nestedNav: { entries, reads } });

const mounts = { sdk: "/products/sdk", cli: "/products/sdk/cli", guide: "/integrations/guide" };
const stubs: Record<string, string> = {
  "virtual:nimbus/config": `
export const config = {};
export const indexedCollections = ${JSON.stringify(Object.keys(entries))};
export const apiCollections = [];
export const collectionRoutes = ${JSON.stringify(Object.entries(mounts).map(([name, mount]) => [name, { mount, aliases: [] }]))};`,
  "astro:config/client": `export const trailingSlash = "ignore"; export const build = { format: "directory" };`,
  "astro:content": `
export async function getCollection(name) {
  const { entries, reads } = globalThis.__nestedNav;
  reads.push(name);
  return (entries[name] ?? []).map((entry) => ({ ...entry, collection: name }));
}`,
};
// Astro defines `import.meta.env` in a build; plain Node doesn't.
const SRC = new URL("../src/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = stubs[specifier];
    if (stub === undefined) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith(SRC) || loaded.source === undefined) return loaded;
    return { ...loaded, source: `import.meta.env ??= { PROD: true, DEV: false, BASE_URL: "/" };\n${loaded.source}` };
  },
});

test("a cold build reads each candidate once; warm calls read nothing", async () => {
  const { clearNavCaches, getSidebar } = await import("../src/runtime.js");
  const count = (name: string) => reads.filter((read) => read === name).length;

  const tree = await getSidebar("/products/sdk/setup", { collection: "sdk" });
  const labels: string[] = [];
  const walk = (items: typeof tree): void => {
    for (const item of items) {
      labels.push(item.label);
      if (item.type === "group") walk(item.children);
    }
  };
  walk(tree);
  assert.deepEqual(labels, ["Integrations", "Guide", "Start", "Kafka", "Products", "Intro", "SDK", "Cli", "Run", "Setup"]);
  for (const name of Object.keys(entries)) assert.equal(count(name), 1, name);

  reads.length = 0;
  for (let i = 0; i < 10; i++) await getSidebar("/products/sdk/setup", { collection: "sdk" });
  assert.deepEqual(reads, []);

  // Two concurrent cold calls each build the tree; entry reads are shared
  // only once one has finished. Recorded, not changed here.
  clearNavCaches();
  await Promise.all([getSidebar("/products/intro"), getSidebar("/integrations/kafka")]);
  for (const name of Object.keys(entries)) assert.equal(count(name), 2, name);
});
