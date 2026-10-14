// Partial builds (`NIMBUS_BUILD_ONLY`) on a 200-pages-per-locale corpus:
// what a slice builds, what it leaves empty, and that a full build after a
// slice build (and a slice build after a full one) leaves Astro's persisted
// store and `dist/` correct. One site, built in sequence: these builds are
// the expensive part of the suite.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { build } from "astro";

import {
  captureOutput,
  htmlPaths,
  persistedStoreCounts,
  sliceSite,
  withBuildOnly,
  type SliceSite,
} from "./fixtures/slice-site.ts";

const PAGES = 200;
/** The smallco spec's pages: 5 operations, 3 tags, 1 webhook, the index. */
const API_PAGES = 10;

function byCollection(paths: string[]): Record<"docs" | "docs-es" | "api", number> {
  const counts = { docs: 0, "docs-es": 0, api: 0 };
  for (const file of paths) {
    if (file.startsWith("/docs-es/")) counts["docs-es"]++;
    else if (file.startsWith("/api/")) counts.api++;
    else counts.docs++;
  }
  return counts;
}

async function expectFullOutput(site: SliceSite): Promise<void> {
  assert.deepEqual(byCollection(await htmlPaths(site)), {
    docs: PAGES + 1,
    "docs-es": PAGES,
    api: API_PAGES,
  });
  assert.deepEqual(await persistedStoreCounts(site), {
    docs: PAGES + 1,
    "docs-es": PAGES,
    api: API_PAGES,
  });
  const truth = JSON.parse(await site.read(".nimbus/routes.json")) as Record<string, unknown>;
  assert.equal(truth.slice, undefined);
  assert.ok(!Number.isNaN(Date.parse(truth.builtAt as string)));
}

async function expectSliceOutput(site: SliceSite): Promise<void> {
  // Only the slice's pages are rendered: no `docs` or `api` HTML at all.
  assert.deepEqual(byCollection(await htmlPaths(site)), { docs: 0, "docs-es": PAGES, api: 0 });
  assert.ok(!existsSync(path.join(site.root, "dist/index.html")));
  // Nothing from a previous build survives in Astro's persisted store: the
  // other collections are cleared, so they're absent from the file.
  assert.deepEqual(await persistedStoreCounts(site), { "docs-es": PAGES });
  // The collections still exist as (empty) page collections.
  assert.deepEqual(
    (JSON.parse(await site.read(".nimbus/page-collections.json")) as { collections: string[] })
      .collections,
    ["docs", "docs-es", "api"],
  );
}

test("partial builds: a docs-es slice, then the sequence full, slice, full", async (t) => {
  const site = await sliceSite({ pages: PAGES, logLevel: "info" });
  try {
    await t.test("a docs-es slice builds only docs-es pages and leaves docs and api empty", async () => {
      const { output } = await captureOutput(() =>
        withBuildOnly("docs-es", () => build(site.config)),
      );
      await expectSliceOutput(site);
      // The notices: what is built, what is empty, and the route truth's reach.
      assert.match(
        output,
        /building only docs-es \(NIMBUS_BUILD_ONLY\); docs, api are empty in this build\./,
      );
      assert.match(
        output,
        /slice route truth: \d+ routes \(no previous build\); links into docs, api will be skipped by lint\./,
      );
      // Astro's "does not exist or is empty" warning never fires: the
      // indexed-entry path skips the empty collections.
      assert.doesNotMatch(output, /does not exist or is empty/);
      // The slice's own pages are complete, and `api.ref:` citations into the
      // absent API collection still resolve (the citation index comes from
      // the spec, not the loader).
      const html = await Promise.all(
        site.corpus.es.map((page) => site.read(`dist/docs-es/${page.slug}/index.html`)),
      );
      assert.ok(html.every((page) => !page.includes("api.ref:")));
      const cited = site.corpus.es.filter((page) => page.body.includes("api.ref:api:create"));
      assert.ok(cited.length > 0, "the corpus has at least one citation");
      for (const page of cited) {
        assert.match(
          await site.read(`dist/docs-es/${page.slug}/index.html`),
          /href="\/api\/charges\/create\/?"/,
        );
      }
      // The site's agent index is the root slice's: this slice drops it from
      // its output, with every other root file.
      assert.ok(!existsSync(path.join(site.root, "dist/llms.txt")));
      // The slice's route truth records the slice and when it was built.
      const truth = JSON.parse(await site.read(".nimbus/routes.json")) as {
        slice: { collections: string[]; covered: string[] };
        builtAt: string;
      };
      assert.deepEqual(truth.slice.collections, ["docs-es"]);
      assert.deepEqual(truth.slice.covered, ["docs-es"]);
      assert.ok(!Number.isNaN(Date.parse(truth.builtAt)));
    });

    await t.test("a full build after the slice restores every collection", async () => {
      await withBuildOnly(null, () => build(site.config));
      await expectFullOutput(site);
    });

    await t.test("a slice build after a full build holds only the slice, with the prior's routes", async () => {
      const { output } = await captureOutput(() =>
        withBuildOnly("docs-es", () => build(site.config)),
      );
      await expectSliceOutput(site);
      assert.match(output, /slice route truth: \d+ routes \(\d+ from the previous build\)\./);
      const truth = JSON.parse(await site.read(".nimbus/routes.json")) as {
        slice: { collections: string[]; covered: string[]; priorBuiltAt: string };
        knownRoutes: string[];
      };
      assert.deepEqual(truth.slice.covered, ["docs", "docs-es", "api"]);
      assert.ok(!Number.isNaN(Date.parse(truth.slice.priorBuiltAt)));
      // The prior's routes for the other slices are in the union; the
      // slice's own routes come from this build only.
      assert.ok(truth.knownRoutes.includes(`/${site.corpus.en[0]!.slug}`));
      assert.ok(truth.knownRoutes.includes("/api/charges/create"));
      assert.ok(truth.knownRoutes.includes(`/docs-es/${site.corpus.es[0]!.slug}`));
    });

    await t.test("a second full build is complete again", async () => {
      await withBuildOnly(null, () => build(site.config));
      await expectFullOutput(site);
    });
  } finally {
    await site.remove();
  }
});
