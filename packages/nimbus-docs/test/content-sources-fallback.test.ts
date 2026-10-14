// Every command but `astro build` starts without a source it can't fetch:
// `astro dev` and `astro sync` (the path `astro check` takes) leave the
// source's collections empty, with one warning per start and nothing left
// from an earlier run, while an `api` entry's source or a configuration
// error still fails them; `astro preview` runs no git at all.

import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { build, dev, preview, sync } from "astro";

import { gitRemote } from "./fixtures/git-remote.ts";
import { pageRoute, paritySite, src } from "./fixtures/parity-site.ts";
import { captureOutput, persistedStoreCounts } from "./fixtures/slice-site.ts";

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Widgets API", version: "1.0.0" },
  tags: [{ name: "widgets" }],
  paths: {
    "/widgets": { get: { operationId: "listWidgets", summary: "List widgets", tags: ["widgets"], responses: { "200": { description: "OK" } } } },
  },
};
const WIDGETS = { collection: "widgets", spec: { source: "sdk", path: "docs/openapi.json" } };
const UNAVAILABLE =
  /nimbus: source "sdk" \([^)]+ @ [0-9a-f]{40}\) is unavailable; collection "sdk" is empty until it can be fetched \(restart to retry\)\. A full build fails until then\. git: \S/g;
const WIDGETS_ROUTE = [
  "---",
  `import { getApiStaticPaths, getApiPage } from ${src("runtime.ts")};`,
  "export const prerender = true;",
  `export const getStaticPaths = getApiStaticPaths("widgets");`,
  "const { page } = await getApiPage(Astro);",
  "---",
  "<html><body>{page.title}</body></html>",
].join("\n");
const count = (output: string, pattern: RegExp) => output.match(pattern)?.length ?? 0;

/** `sdk` reads source `sdk`; with `widgets`, an API collection whose spec comes from it. */
async function fallbackSite({ widgets = false } = {}) {
  const site = await paritySite({
    logLevel: "warn",
    extraCollections: [
      `sdk: defineCollection(docsCollection({ source: "sdk" }))`,
      ...(widgets ? [`widgets: defineCollection(apiCollection())`] : []),
    ],
    routes: {
      "src/pages/sdk/[...slug].astro": pageRoute("sdk"),
      ...(widgets ? { "src/pages/widgets/[...slug].astro": WIDGETS_ROUTE } : {}),
    },
  });
  await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
  const remote = await gitRemote(path.join(site.root, "remotes"), {
    "docs/intro.md": "---\ntitle: Intro\n---\n\nThe SDK intro.\n",
    "docs/openapi.json": `${JSON.stringify(SPEC)}\n`,
  });
  const configure = (sdk: Record<string, unknown> = {}, api: unknown[] = []) =>
    site.configure({
      sources: { sdk: { repo: remote.bare, ref: remote.first, path: "docs", ...sdk } },
      nimbus: api.length ? { api: [...defaultApi(), ...api] } : {},
    });
  return { site, remote, configure };
}

/** The parity site's own `api` entry, kept when a test adds one. */
const defaultApi = () => [
  {
    collection: "api",
    spec: path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml"),
    label: "SmallCo API",
    routes: { convention: "resource-action-v2" },
  },
];

test("dev and sync start without an unreachable source: its collection is empty, once warned, and cleared of an earlier run's entries", async () => {
  const { site, remote, configure } = await fallbackSite();
  try {
    await sync(configure());
    assert.ok((await persistedStoreCounts(site)).sdk! > 0, "the reachable run stored the source's pages");

    await rename(remote.bare, `${remote.bare}.gone`);
    rmSync(path.join(site.root, ".nimbus/sources"), { recursive: true, force: true });

    const served = await captureOutput(async () => {
      const server = await dev({ ...configure(), server: { host: "127.0.0.1", port: 0 } });
      try {
        const origin = `http://127.0.0.1:${server.address.port}`;
        const home = await fetch(`${origin}/`);
        assert.equal(home.status, 200);
        assert.match(await home.text(), /Home\./);
        assert.equal((await fetch(`${origin}/llms.txt`)).status, 200);
        assert.equal((await fetch(`${origin}/sdk/intro/`)).status, 404);
      } finally {
        await server.stop();
      }
    });
    assert.equal(count(served.output, UNAVAILABLE), 1, served.output);
    assert.doesNotMatch(served.output, /"sdk" does not exist or is empty/);

    // After the dev server: a sync also replaces the content layer
    // server.stop() leaves subscribed, which would otherwise sync this
    // deleted site when a later test loads its own content config.
    const synced = await captureOutput(() => sync(configure()));
    assert.equal(count(synced.output, UNAVAILABLE), 1, synced.output);
    assert.equal((await persistedStoreCounts(site)).sdk ?? 0, 0, "nothing stale is left");

    // A build is strict.
    await assert.rejects(build(configure()), /could not fetch source "sdk"[\s\S]*Read by: collection "sdk"\./);
  } finally {
    await site.remove();
  }
});

test("dev and sync still fail when an api entry reads the unreachable source, or the source is misconfigured", async () => {
  const { site, remote, configure } = await fallbackSite({ widgets: true });
  try {
    // A path missing at the commit is the author's to fix, reachable or not.
    await assert.rejects(sync(configure({ path: "nowhere" })), /could not check out source "sdk"[\s\S]*path "nowhere" does not exist/);

    await rename(remote.bare, `${remote.bare}.gone`);
    await assert.rejects(
      sync(configure({}, [WIDGETS])),
      /could not fetch source "sdk"[\s\S]*Read by: collection "sdk" and api entry "widgets"\./,
    );
  } finally {
    await site.remove();
  }
});

test("astro preview runs no git and serves a site whose API spec comes from a source", async () => {
  const { site, remote, configure } = await fallbackSite({ widgets: true });
  const savedPath = process.env.PATH;
  try {
    await build(configure({ ref: "main" }, [WIDGETS]));
    const current = path.join(site.root, ".nimbus/sources/current.json");
    const before = { text: readFileSync(current, "utf8"), mtime: statSync(current).mtimeMs };
    const widgetsPage = readdirSync(path.join(site.root, "dist/widgets"), { recursive: true })
      .map(String)
      .find((file) => file.endsWith("index.html"));
    assert.ok(widgetsPage);

    await rename(remote.bare, `${remote.bare}.gone`);
    // Any git command would be recorded here.
    const bin = path.join(site.root, "bin");
    const calls = path.join(site.root, "git-calls.log");
    await site.write("bin/git", `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nexit 1\n`);
    chmodSync(path.join(bin, "git"), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;

    const server = await preview({ ...configure({ ref: "main" }, [WIDGETS]), server: { host: "127.0.0.1", port: 0 } });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      assert.equal((await fetch(`${origin}/widgets/${path.dirname(widgetsPage)}/`)).status, 200);
      const intro = await fetch(`${origin}/sdk/intro/`);
      assert.equal(intro.status, 200);
      assert.match(await intro.text(), /The SDK intro\./);
    } finally {
      await server.stop();
    }
    assert.equal(readFileSync(current, "utf8"), before.text);
    assert.equal(statSync(current).mtimeMs, before.mtime, "preview doesn't write current.json");

    // With no snapshot, preview says so without claiming the source is
    // unreachable: it never fetched it.
    rmSync(path.join(site.root, ".nimbus/sources"), { recursive: true, force: true });
    const started = await captureOutput(async () => {
      const bare = await preview({ ...configure({ ref: "main" }), server: { host: "127.0.0.1", port: 0 } });
      await bare.stop();
    });
    assert.match(
      started.output,
      /nimbus: source "sdk" \([^)]+ @ main\) has no snapshot yet; collection "sdk" is empty \(run a build to fetch it\)\./,
    );
    assert.doesNotMatch(started.output, /A full build fails|could not fetch|Give git a credential/);
    // An API reference can't render without its spec.
    await assert.rejects(preview({ ...configure({ ref: "main" }, [WIDGETS]), server: { host: "127.0.0.1", port: 0 } }), (error: Error) => {
      assert.match(
        error.message,
        /source "sdk" \([^)]+ @ main\) has no snapshot; run astro build first\.\n {2}Read by: collection "sdk" and api entry "widgets"\./,
      );
      assert.doesNotMatch(error.message, /could not fetch|Give git a credential/);
      return true;
    });
    assert.ok(!existsSync(calls), existsSync(calls) ? readFileSync(calls, "utf8") : "");
  } finally {
    process.env.PATH = savedPath;
    await site.remove();
  }
});
