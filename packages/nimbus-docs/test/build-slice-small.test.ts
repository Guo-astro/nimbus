// Partial builds (`NIMBUS_BUILD_ONLY`) on a small corpus: the author errors,
// the commands that ignore the variable, links across slices through the
// route truth and `nimbus-docs lint`, and the request-rendered variant.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { build, dev, sync } from "astro";

import {
  buildSliceProblem,
  parseBuildOnly,
  routeOwner,
} from "../src/_internal/build-slice.ts";
import {
  captureOutput,
  htmlPaths,
  persistedStoreCounts,
  sliceSite,
  withBuildOnly,
  type SliceSite,
} from "./fixtures/slice-site.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const PAGES = 6;

interface LintEnvelope {
  diagnostics: Array<{ code: string; severity: string; file: string; message: string }>;
}

function lintCli(site: SliceSite, dir: string, env: Record<string, string> = {}) {
  const res = spawnSync(
    process.execPath,
    ["--import", TSX, CLI, "lint", dir, "--format", "json"],
    { cwd: site.root, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return { ...res, envelope: JSON.parse(res.stdout) as LintEnvelope };
}

test("the variable parses as a list and the slice checks name the site's collections", () => {
  assert.equal(parseBuildOnly(undefined), null);
  assert.equal(parseBuildOnly("  "), null);
  assert.deepEqual(parseBuildOnly("docs-es"), ["docs-es"]);
  assert.deepEqual(parseBuildOnly(" docs , api ,docs"), ["docs", "api"]);

  const site = { pageCollections: ["docs", "docs-es", "api"], versionCollections: [] };
  assert.equal(buildSliceProblem(["docs-es"], site), null);
  assert.match(
    buildSliceProblem(["docs-fr"], site)!.message,
    /NIMBUS_BUILD_ONLY names "docs-fr", which is not a page collection\. Page collections in this site: docs, docs-es, api\./,
  );
  const versioned = {
    pageCollections: ["docs", "docs-v1", "docs-es", "api"],
    versionCollections: ["docs", "docs-v1"],
  };
  assert.equal(buildSliceProblem(["docs", "docs-v1"], versioned), null);
  assert.equal(buildSliceProblem(["docs-es"], versioned), null);
  assert.match(
    buildSliceProblem(["docs", "api"], versioned)!.message,
    /holds "docs" but not "docs-v1"\. A site's docs version collections \(docs, docs-v1\) build together\./,
  );

  const mounts = { docs: "", "docs-es": "/docs-es", api: "/api" };
  assert.equal(routeOwner("/", mounts), "docs");
  assert.equal(routeOwner("/guides/x", mounts), "docs");
  assert.equal(routeOwner("/docs-es", mounts), "docs-es");
  assert.equal(routeOwner("/docs-es/guides/x", mounts), "docs-es");
  assert.equal(routeOwner("/docs-estate", mounts), "docs");
  assert.equal(routeOwner("/api/charges/create", mounts), "api");
  assert.equal(routeOwner("/x", { api: "/api" }), undefined);
});

test("an unknown collection fails the build naming the site's page collections", async () => {
  const site = await sliceSite({ pages: PAGES });
  try {
    await assert.rejects(
      withBuildOnly("docs-fr", () => build(site.config)),
      /NIMBUS_BUILD_ONLY names "docs-fr", which is not a page collection\. Page collections in this site: docs, docs-es, api\./,
    );
    // A failed build leaves no route truth or page-collection list behind.
    assert.ok(!existsSync(path.join(site.root, ".nimbus/routes.json")));
    assert.ok(!existsSync(path.join(site.root, ".nimbus/page-collections.json")));
  } finally {
    await site.remove();
  }
});

test("a slice with docs but not docs-v1 fails on a versioned site", async () => {
  const site = await sliceSite({ pages: PAGES, versions: true });
  try {
    await assert.rejects(
      withBuildOnly("docs,api", () => build(site.config)),
      /NIMBUS_BUILD_ONLY holds "docs" but not "docs-v1"\. A site's docs version collections \(docs, docs-v1\) build together\./,
    );
    // The other locale alone is fine on the same site. (The version redirect
    // pages under `/v1/` are still written: they come from a filesystem scan,
    // and this build doesn't filter them.)
    await withBuildOnly("docs-es", () => build(site.config));
    const paths = await htmlPaths(site);
    assert.equal(paths.filter((file) => file.startsWith("/docs-es/")).length, PAGES);
    assert.ok(paths.every((file) => file.startsWith("/docs-es/") || file.startsWith("/v1/")), paths.join(" "));
    assert.ok(!existsSync(path.join(site.root, `dist/${site.corpus.en[0]!.slug}`)));
  } finally {
    await site.remove();
  }
});

test("astro dev and astro sync treat the variable as unset, with one notice", async () => {
  const site = await sliceSite({ pages: PAGES, logLevel: "warn" });
  try {
    const synced = await captureOutput(() => withBuildOnly("docs-es", () => sync(site.config)));
    assert.equal(
      synced.output.match(/NIMBUS_BUILD_ONLY is set \(docs-es\), but only `astro build` builds a slice; `astro sync` uses the whole site and ignores it\./g)?.length,
      1,
    );
    assert.deepEqual(await persistedStoreCounts(site), {
      docs: PAGES + 1,
      "docs-es": PAGES,
      api: 10,
    });

    // A fresh integration: the notice prints once per integration instance.
    const devSite = await sliceSite({ pages: PAGES, logLevel: "warn" });
    const served = await captureOutput(() =>
      withBuildOnly("docs-es", async () => {
        const server = await dev({ ...devSite.config, server: { host: "127.0.0.1", port: 0 } });
        try {
          const origin = `http://127.0.0.1:${server.address.port}`;
          const en = await fetch(`${origin}/${devSite.corpus.en[0]!.slug}/`);
          assert.equal(en.status, 200);
          assert.match(await en.text(), /data-collection="docs"/);
          const es = await fetch(`${origin}/docs-es/${devSite.corpus.es[0]!.slug}/`);
          assert.equal(es.status, 200);
          assert.match(await es.text(), /data-collection="docs-es"/);
          const api = await fetch(`${origin}/api/charges/create/`);
          assert.equal(api.status, 200);
        } finally {
          await server.stop();
          await devSite.remove();
        }
      }),
    );
    assert.equal(
      served.output.match(/NIMBUS_BUILD_ONLY is set \(docs-es\), but only `astro build` builds a slice; `astro dev` uses the whole site and ignores it\./g)?.length,
      1,
    );
  } finally {
    await site.remove();
  }
});

test("nimbus-docs check ignores the variable with one notice", async () => {
  const dir = await mkdtemp(path.join(TEST_TMP, "nimbus-slice-check-"));
  try {
    await writeFile(path.join(dir, "package.json"), '{ "name": "fixture" }');
    await writeFile(
      path.join(dir, "astro.config.ts"),
      `import nimbus from "@cloudflare/nimbus-docs";\nexport default { integrations: [nimbus({ site: "https://docs.example.com", title: "X", search: false })] };`,
    );
    const res = spawnSync(process.execPath, ["--import", TSX, CLI, "check", "--env", "--json"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NIMBUS_BUILD_ONLY: "docs-es" },
    });
    assert.equal(
      res.stderr.match(/NIMBUS_BUILD_ONLY is set, but only `astro build` builds a slice; check reads the whole site and ignores it\./g)?.length,
      1,
      res.stderr,
    );
    assert.doesNotThrow(() => JSON.parse(res.stdout));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("links into another slice resolve against the previous build, as warnings, or are skipped", async () => {
  const site = await sliceSite({
    pages: PAGES,
    logLevel: "info",
    rules: { "nimbus/internal-link": "error" },
  });
  try {
    // A page whose links are broken in both slices.
    await site.write(
      "src/content/docs-es/guides/broken.mdx",
      "---\ntitle: Broken (es)\n---\n\n[missing here](/docs-es/guides/does-not-exist/) and [missing there](/guides/does-not-exist/).\n",
    );
    const dir = "src/content/docs-es";

    // Full build, then the slice: links into `docs` are checked against the
    // previous build's routes, and a broken one is a warning, never an error.
    await withBuildOnly(null, () => build(site.config));
    const withPrior = await captureOutput(() => withBuildOnly("docs-es", () => build(site.config)));
    assert.match(withPrior.output, /slice route truth: \d+ routes \(\d+ from the previous build\)\./);
    const truth = JSON.parse(await site.read(".nimbus/routes.json")) as {
      slice: { collections: string[]; covered: string[] };
      builtAt: string;
    };
    assert.deepEqual(truth.slice.collections, ["docs-es"]);
    assert.deepEqual(truth.slice.covered, ["docs", "docs-es", "api"]);
    assert.ok(!Number.isNaN(Date.parse(truth.builtAt)));

    const checked = lintCli(site, dir);
    assert.equal(
      checked.stderr.match(/nimbus\/internal-link: this route truth is from a partial build \(docs-es\); links into other slices are checked against the previous build's routes and reported as warnings\./g)?.length,
      1,
      checked.stderr,
    );
    const findings = checked.envelope.diagnostics
      .filter((d) => d.code === "nimbus/internal-link")
      .map((d) => [d.severity, d.message.replace(/ — .*$/, "")]);
    assert.deepEqual(findings, [
      ["error", 'broken link "/docs-es/guides/does-not-exist/"'],
      ["warn", 'broken link "/guides/does-not-exist/"'],
    ]);
    // Every corpus page links into `docs`; none of those is reported.
    assert.equal(checked.envelope.diagnostics.filter((d) => d.file !== "src/content/docs-es/guides/broken.mdx").length, 0);

    // Without a previous build, links into the other slices are skipped,
    // and lint says so once.
    await rm(path.join(site.root, ".nimbus/routes.json"));
    const withoutPrior = await captureOutput(() => withBuildOnly("docs-es", () => build(site.config)));
    assert.match(
      withoutPrior.output,
      /slice route truth: \d+ routes \(no previous build\); links into docs, api will be skipped by lint\./,
    );
    const skipped = lintCli(site, dir);
    assert.equal(
      skipped.stderr.match(/nimbus\/internal-link: this route truth is from a partial build \(docs-es\) with no previous build covering docs, api, so links into the site root, \/api are not checked\./g)?.length,
      1,
      skipped.stderr,
    );
    assert.deepEqual(
      skipped.envelope.diagnostics
        .filter((d) => d.code === "nimbus/internal-link")
        .map((d) => [d.severity, d.message.replace(/ — .*$/, "")]),
      [["error", 'broken link "/docs-es/guides/does-not-exist/"']],
    );

    // A full build's truth has no slice record, and lint prints no notice.
    await withBuildOnly(null, () => build(site.config));
    const full = lintCli(site, dir);
    assert.doesNotMatch(full.stderr, /partial build/);
    assert.deepEqual(
      full.envelope.diagnostics.map((d) => d.severity),
      ["error", "error"],
    );
  } finally {
    await site.remove();
  }
});

test("a request-rendered docs-es slice serves its pages and logs no empty-collection warning", async () => {
  const site = await sliceSite({
    pages: PAGES,
    server: true,
    rendering: { collections: { "docs-es": "request" } },
    logLevel: "warn",
  });
  try {
    const built = await captureOutput(() => withBuildOnly("docs-es", () => build(site.config)));
    assert.doesNotMatch(built.output, /does not exist or is empty/);
    // Nothing of `docs` or `api` is prerendered, and neither is the slice
    // (it renders on request).
    assert.deepEqual(await htmlPaths(site), []);
    assert.ok(!existsSync(path.join(site.root, "dist/docs-es")));
    assert.deepEqual(await persistedStoreCounts(site), { "docs-es": PAGES });

    const { app } = (await import(
      pathToFileURL(path.join(site.root, ".server", "entry.mjs")).href
    )) as { app: { render(request: Request): Promise<Response> } };
    const served = await captureOutput(async () => {
      const responses: Array<[number, string]> = [];
      for (const page of site.corpus.es.slice(0, 3)) {
        const response = await app.render(
          new Request(`https://docs.example.test/docs-es/${page.slug}/`),
        );
        responses.push([response.status, await response.text()]);
      }
      return responses;
    });
    for (const [status, body] of served.result) {
      assert.equal(status, 200);
      assert.match(body, /data-collection="docs-es"/);
      // The indexed-entry path ran per request and saw only the slice.
      assert.match(body, new RegExp(`data-indexed="${PAGES}"`));
    }
    assert.doesNotMatch(served.output, /does not exist or is empty/);
    assert.doesNotMatch(served.output, /\[WARN\]/);
  } finally {
    await site.remove();
  }
});
