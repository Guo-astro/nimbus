// `/sitemap.xml` alias: copied from `sitemap-index.xml` unless the site
// already serves its own, or no index was written.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  isSitemapRoutePattern,
  shouldCopySitemapAlias,
  sitemapAliasIntegration,
} from "../src/_internal/sitemap-alias.js";

async function withOutDir(run: (outDir: string) => Promise<void>) {
  const outDir = await mkdtemp(path.join(tmpdir(), "nimbus-sitemap-"));
  try {
    await run(outDir);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

async function runHook(outDir: string, hasOwnSitemapRoute = false) {
  const integration = sitemapAliasIntegration({ hasOwnSitemapRoute: () => hasOwnSitemapRoute });
  const hook = integration.hooks["astro:build:done"]!;
  await (hook as (options: { dir: URL }) => Promise<void>)({ dir: pathToFileURL(`${outDir}/`) });
}

test("copies the index to sitemap.xml", async () => {
  await withOutDir(async (outDir) => {
    await writeFile(path.join(outDir, "sitemap-index.xml"), "<index/>");
    assert.equal(shouldCopySitemapAlias({ outDir, hasOwnSitemapRoute: false }), true);
    await runHook(outDir);
    assert.equal(await readFile(path.join(outDir, "sitemap.xml"), "utf8"), "<index/>");
  });
});

test("no index (sitemap off or no pages): nothing is written", async () => {
  await withOutDir(async (outDir) => {
    assert.equal(shouldCopySitemapAlias({ outDir, hasOwnSitemapRoute: false }), false);
    await runHook(outDir);
    await assert.rejects(readFile(path.join(outDir, "sitemap.xml")));
  });
});

test("a site's own sitemap.xml (static file or prerendered route) is left alone", async () => {
  await withOutDir(async (outDir) => {
    await writeFile(path.join(outDir, "sitemap-index.xml"), "<index/>");
    await writeFile(path.join(outDir, "sitemap.xml"), "<mine/>");
    assert.equal(shouldCopySitemapAlias({ outDir, hasOwnSitemapRoute: false }), false);
    await runHook(outDir);
    assert.equal(await readFile(path.join(outDir, "sitemap.xml"), "utf8"), "<mine/>");
  });
});

test("an on-demand /sitemap.xml route blocks the copy", async () => {
  await withOutDir(async (outDir) => {
    await writeFile(path.join(outDir, "sitemap-index.xml"), "<index/>");
    assert.equal(shouldCopySitemapAlias({ outDir, hasOwnSitemapRoute: true }), false);
    await runHook(outDir, true);
    await assert.rejects(readFile(path.join(outDir, "sitemap.xml")));
  });
});

test("isSitemapRoutePattern: exactly /sitemap.xml", () => {
  assert.equal(isSitemapRoutePattern("/sitemap.xml"), true);
  assert.equal(isSitemapRoutePattern("/sitemap.xml/"), true);
  assert.equal(isSitemapRoutePattern("/sitemap-index.xml"), false);
  assert.equal(isSitemapRoutePattern("/docs/sitemap.xml"), false);
  // a dynamic root .xml route would answer /sitemap.xml too
  assert.equal(isSitemapRoutePattern("/[name].xml"), true);
  assert.equal(isSitemapRoutePattern("/[...all].xml"), true);
  assert.equal(isSitemapRoutePattern("/feeds/[name].xml"), false);
  assert.equal(isSitemapRoutePattern("/[...slug]"), false);
  assert.equal(isSitemapRoutePattern("/[...slug]"), false);
});
