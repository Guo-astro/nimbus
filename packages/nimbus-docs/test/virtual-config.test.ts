import assert from "node:assert/strict";
import { test } from "node:test";
import { virtualApiBuildConfigPlugin } from "../src/_internal/virtual-api-build-config.js";
import { virtualConfigPlugin } from "../src/_internal/virtual-config.js";
import { virtualLastUpdatedPlugin } from "../src/_internal/last-updated-virtual.js";
import type { NimbusConfig } from "../src/types.js";

const sentinel = "raw-openapi-must-not-ship";
const api = [
  {
    collection: "api",
    spec: {
      openapi: "3.1.0",
      info: { title: "API", version: "1" },
      paths: {},
      sentinel,
    },
  },
];

test("runtime config strips inline API specs", async () => {
  const config = { api } as NimbusConfig;
  const plugin = virtualConfigPlugin(config, {
    getIndexedCollections: async () => ["api"],
    requestRenderingCollections: ["api"],
    versionAlternates: {},
    apiCollections: ["api"],
    headDefaults: {
      favicon: { file: "/favicon.ico", type: "image/x-icon" },
      socialImage: "/opengraph.png",
    },
  });
  const source = await plugin.load("\0virtual:nimbus/config");

  assert.ok(source);
  assert.ok(!source.includes(sentinel));
  assert.match(source, /"spec":\{\}/);
  assert.match(source, /indexedCollections = \["api"\]/);
});

test("build-only API config retains specs and the project root", () => {
  const plugin = virtualApiBuildConfigPlugin(api, "/project");
  const source = plugin.load("\0virtual:nimbus/api-build-config");

  assert.ok(source);
  assert.ok(source.includes(sentinel));
  assert.ok(source.includes("/project"));
});

test("request rendering resolves last-updated from prepared data", () => {
  const plugin = virtualLastUpdatedPlugin({
    "src/content/docs/index.mdx": "2026-01-01T00:00:00.000Z",
  });
  assert.equal(plugin.enforce, "pre");
  const id = plugin.resolveId(
    "./git-last-updated-D5zEYWjA.js",
    "/package/dist/runtime.js",
  );
  assert.equal(id, "\0virtual:nimbus/last-updated");
  assert.equal(
    plugin.resolveId(
      "/package/dist/git-last-updated-D5zEYWjA.js?commonjs-proxy",
      "/package/dist/runtime.js?astro",
    ),
    "\0virtual:nimbus/last-updated",
  );
  const source = plugin.load(id!);
  assert.match(source!, /2026-01-01T00:00:00\.000Z/);
  assert.doesNotMatch(source!, /node:child_process/);
});

test("a content.config.ts edit invalidates the virtual config in dev", async () => {
  const lists: string[][] = [["docs"], ["docs", "blog"]];
  const plugin = virtualConfigPlugin({} as NimbusConfig, {
    getIndexedCollections: async () => lists.shift() ?? ["docs", "blog"],
    requestRenderingCollections: [],
    versionAlternates: {},
    apiCollections: [],
    headDefaults: {
      favicon: { file: "/favicon.ico", type: "image/x-icon" },
      socialImage: "/opengraph.png",
    },
    contentConfigPath: "/project/src/content.config.ts",
  });
  assert.match(
    (await plugin.load("\0virtual:nimbus/config")) ?? "",
    /indexedCollections = \["docs"\]/,
  );
  let invalidatedAll = 0;
  const server = {
    moduleGraph: {
      getModuleById: () => undefined,
      invalidateModule: () => {},
      invalidateAll: () => {
        invalidatedAll += 1;
      },
    },
  };
  plugin.handleHotUpdate?.({ file: "/project/src/other.ts", server });
  assert.equal(invalidatedAll, 0);
  plugin.handleHotUpdate?.({ file: "/project/src/content.config.ts", server });
  assert.equal(invalidatedAll, 1);
  assert.match(
    (await plugin.load("\0virtual:nimbus/config")) ?? "",
    /indexedCollections = \["docs","blog"\]/,
  );
});
