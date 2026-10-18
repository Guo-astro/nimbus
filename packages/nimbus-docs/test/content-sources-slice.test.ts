// Partial builds fetch only the sources their collections read: a source no
// collection in NIMBUS_BUILD_ONLY reads is never fetched and keeps exactly
// its current snapshot; an `api` entry, or a content config whose reads
// can't be seen without running it, makes the slice fetch every source; a
// read the content config hides fails naming the skipped source. Two sources
// over bare repositories on disk: `a`, read by `docs`, and `b`, read by `sdk`.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { build } from "astro";

import { gitRemote } from "./fixtures/git-remote.ts";
import { pageRoute, paritySite, src, type ParitySite } from "./fixtures/parity-site.ts";
import { captureOutput, withBuildOnly } from "./fixtures/slice-site.ts";

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Widgets API", version: "1.0.0" },
  paths: { "/widgets": { get: { operationId: "listWidgets", responses: { "200": { description: "OK" } } } } },
};

const SKIPPED_B = /nimbus: source "b" not fetched: no collection in NIMBUS_BUILD_ONLY=docs reads it\./g;
const FETCHES_EVERY = /NIMBUS_BUILD_ONLY fetches every source: /g;
const count = (output: string, pattern: RegExp) => output.match(pattern)?.length ?? 0;

/**
 * `docs` reads source `a` and `sdk` reads source `b`. `sdkEntry` replaces
 * the `sdk` collection's line; `head` goes above the collections.
 */
async function twoSourceSite(options: { sdkEntry?: string; head?: string[] } = {}) {
  const site = await paritySite({
    logLevel: "info",
    extraCollections: [options.sdkEntry ?? `sdk: defineCollection(docsCollection({ source: "b" }))`],
    routes: { "src/pages/sdk/[...slug].astro": pageRoute("sdk") },
  });
  const config = (await site.read("src/content.config.ts"))
    .replace("docs: defineCollection(docsCollection()),", `docs: defineCollection(docsCollection({ source: "a" })),`)
    .replace("export const collections = {", [...(options.head ?? []), "export const collections = {"].join("\n"));
  await site.write("src/content.config.ts", config);
  const a = await gitRemote(path.join(site.root, "remotes/a"), {
    "docs/index.md": "---\ntitle: Home\n---\n\nHome from a.\n",
    "docs/guide.md": "---\ntitle: Guide\n---\n\nA guide from a.\n",
  });
  const b = await gitRemote(path.join(site.root, "remotes/b"), {
    "docs/intro.md": "---\ntitle: Intro\n---\n\nThe SDK, version one.\n",
    "docs/openapi.json": `${JSON.stringify(SPEC)}\n`,
  });
  const configure = (bRef: string = b.first, nimbus: Record<string, unknown> = {}) =>
    site.configure({
      sources: {
        a: { repo: a.bare, ref: a.first, path: "docs" },
        b: { repo: b.bare, ref: bRef, path: "docs" },
      },
      nimbus,
    });
  const removeB = () => rename(b.bare, `${b.bare}.gone`);
  return { site, a, b, configure, removeB };
}

/** Commit folders under `.nimbus/sources/<name>`, as `<identity>/<commit>`. */
function snapshotsOf(site: ParitySite, name: string): string[] {
  const root = path.join(site.root, ".nimbus/sources", name);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .flatMap((identity) =>
      readdirSync(path.join(root, identity))
        .filter((entry) => /^[0-9a-f]{40}$/.test(entry))
        .map((commit) => `${identity}/${commit}`),
    )
    .sort();
}

function currentSources(site: ParitySite): Record<string, { dir: string }> {
  return (JSON.parse(readFileSync(path.join(site.root, ".nimbus/sources/current.json"), "utf8")) as {
    sources: Record<string, { dir: string }>;
  }).sources;
}

test("a slice never fetches a source none of its collections reads, and never creates its folder", async () => {
  const { site, configure, removeB } = await twoSourceSite();
  try {
    await removeB();
    const { output } = await captureOutput(() => withBuildOnly("docs", () => build(configure())));
    assert.equal(count(output, SKIPPED_B), 1, output);
    assert.equal(count(output, FETCHES_EVERY), 0);
    assert.ok(!existsSync(path.join(site.root, ".nimbus/sources/b")));
    assert.match(await site.read("dist/guide/index.html"), /A guide from a\./);
    assert.deepEqual(Object.keys(currentSources(site)), ["a"]);

    // A full build is strict: the unreachable source fails it, naming who reads it.
    await assert.rejects(build(configure()), (error: Error) => {
      assert.match(error.message, /could not fetch source "b" \([^)]+\): [\s\S]+\. No snapshot of this repo, ref and path exists under \.nimbus\/sources\/b\/\./);
      assert.match(error.message, /\n {2}Read by: collection "sdk"\.\n/);
      assert.match(error.message, /Give git a credential: https:\/\/nimbus-docs\.com\/content-sources\/git\/#private-repositories/);
      assert.doesNotMatch(error.message, /NIMBUS_BUILD_ONLY/);
      return true;
    });
  } finally {
    await site.remove();
  }
});

test("a skipped pinned source keeps exactly its current snapshot, and the next full build reads it offline", async () => {
  const { site, b, configure, removeB } = await twoSourceSite();
  try {
    await build(configure());
    const [current] = snapshotsOf(site, "b");
    const identity = current!.split("/")[0]!;
    // An older snapshot of the same declaration, and one of a declaration gone since.
    mkdirSync(path.join(site.root, ".nimbus/sources/b", identity, "1".repeat(40)), { recursive: true });
    mkdirSync(path.join(site.root, ".nimbus/sources/b/0123456789abcdef", "2".repeat(40)), { recursive: true });
    await removeB();

    const { output } = await captureOutput(() => withBuildOnly("docs", () => build(configure())));
    assert.equal(count(output, SKIPPED_B), 1, output);
    assert.deepEqual(snapshotsOf(site, "b"), [`${identity}/${b.first}`]);
    assert.equal(currentSources(site).b?.dir, `.nimbus/sources/b/${identity}/${b.first}`);

    await build(configure());
    assert.match(await site.read("dist/sdk/intro/index.html"), /The SDK, version one\./);
  } finally {
    await site.remove();
  }
});

test("a skipped floating source keeps the commit it last selected, without asking the remote", async () => {
  const { site, b, configure } = await twoSourceSite();
  try {
    await build(configure("main"));
    await b.commit({ "docs/intro.md": "---\ntitle: Intro\n---\n\nThe SDK, version two.\n" });
    const { output } = await captureOutput(() => withBuildOnly("docs", () => build(configure("main"))));
    assert.equal(count(output, SKIPPED_B), 1, output);
    assert.deepEqual(snapshotsOf(site, "b").map((dir) => dir.split("/")[1]), [b.first]);
    assert.match(currentSources(site).b!.dir, new RegExp(`/${b.first}$`));
  } finally {
    await site.remove();
  }
});

test("an api entry that reads a source makes every slice fetch it", async () => {
  const { site, configure, removeB } = await twoSourceSite();
  try {
    await removeB();
    const widgets = { api: [{ collection: "widgets", spec: { source: "b", path: "docs/openapi.json" } }] };
    const { output } = await captureOutput(() =>
      assert.rejects(
        withBuildOnly("docs", () => build(configure(undefined, widgets))),
        /could not fetch source "b"[\s\S]*Read by: collection "sdk" and api entry "widgets"\./,
      ),
    );
    assert.equal(count(output, SKIPPED_B), 0);
  } finally {
    await site.remove();
  }
});

test("a content config whose source reads can't be seen makes a slice fetch every source, with one line naming why", async () => {
  const cases: Array<{ name: string; sdkEntry: string; head?: string[]; files?: Record<string, string>; names: string }> = [
    {
      name: "a spread entry",
      sdkEntry: `sdk: defineCollection(docsCollection({ source: "b" })),\n  ...extraCollections`,
      head: ["const extraCollections = {};"],
      names: "the entry `...extraCollections`",
    },
    {
      name: "an imported collection",
      sdkEntry: "sdk",
      head: [`import { sdk } from "./sdk-collection.ts";`],
      files: {
        "src/sdk-collection.ts": `import { defineCollection } from "astro:content";\nimport { docsCollection } from ${src("content.ts")};\nexport const sdk = defineCollection(docsCollection({ source: "b" }));\n`,
      },
      names: `collection "sdk"`,
    },
    {
      name: "a docsCollection loader in a hand-written collection",
      sdkEntry: `sdk: defineCollection({ loader: docsCollection({ source: "b" }).loader })`,
      names: `collection "sdk"`,
    },
    {
      name: "a non-literal source",
      sdkEntry: `sdk: defineCollection(docsCollection({ source: sdkSource }))`,
      head: [`const sdkSource = "b";`],
      names: `collection "sdk"`,
    },
    {
      name: "a shorthand source",
      sdkEntry: `sdk: defineCollection(docsCollection({ source }))`,
      head: [`const source = "b";`],
      names: `collection "sdk"`,
    },
    {
      name: "an options variable",
      sdkEntry: `sdk: defineCollection(docsCollection(sdkOptions))`,
      head: [`const sdkOptions = { source: "b" };`],
      names: `collection "sdk"`,
    },
    {
      name: "an imported helper",
      sdkEntry: `sdk: makeSdk("b")`,
      head: [`import { makeSdk } from "./sdk-helper.ts";`],
      files: {
        "src/sdk-helper.ts": `import { defineCollection } from "astro:content";\nimport { docsCollection } from ${src("content.ts")};\nexport const makeSdk = (source: string) => defineCollection(docsCollection({ source }));\n`,
      },
      names: `collection "sdk"`,
    },
    {
      name: "an aliased import",
      sdkEntry: `sdk: defineCollection(dc({ source: "b" }))`,
      head: [`import { docsCollection as dc } from ${src("content.ts")};`],
      names: `collection "sdk"`,
    },
  ];
  for (const { name, sdkEntry, head, files, names } of cases) {
    const { site, configure, removeB } = await twoSourceSite({ sdkEntry, head });
    try {
      for (const [file, body] of Object.entries(files ?? {})) await site.write(file, body);
      await removeB();
      const { output } = await captureOutput(() =>
        assert.rejects(
          withBuildOnly("docs", () => build(configure())),
          /could not fetch source "b"[\s\S]*Read by: (?:collection "sdk" and )?collections src\/content\.config\.ts doesn't show\./,
          name,
        ),
      );
      assert.equal(count(output, FETCHES_EVERY), 1, `${name}: ${output}`);
      assert.ok(
        output.includes(
          `NIMBUS_BUILD_ONLY fetches every source: ${names} sets its source in a way the build can't read without running src/content.config.ts. Write source as a string literal to let slices skip it.`,
        ),
        `${name}: ${output}`,
      );
      assert.equal(count(output, SKIPPED_B), 0, name);
    } finally {
      await site.remove();
    }
  }
});

test("a source read the content config doesn't show fails the slice naming the skipped source", async () => {
  // The read is in another module; `docsCollection().schema`, as in a
  // hand-written loader's collection, reads no source and keeps the map whole.
  const { site, configure } = await twoSourceSite({
    sdkEntry: `sdk: defineCollection({ loader: sdkLoader, schema: docsCollection().schema })`,
    head: [`import { sdkLoader } from "./sdk-loader.ts";`],
  });
  try {
    await site.write(
      "src/sdk-loader.ts",
      `import { docsCollection } from ${src("content.ts")};\nexport const sdkLoader = docsCollection({ source: "b" }).loader;\n`,
    );
    const { output } = await captureOutput(() =>
      assert.rejects(withBuildOnly("sdk", () => build(configure())), (error: Error) => {
        assert.match(
          error.message,
          /collection "sdk" reads source "b", which this slice skipped because src\/content\.config\.ts doesn't show the read; write source as a string literal in docsCollection\(\) in src\/content\.config\.ts, not in a helper or another module/,
        );
        assert.doesNotMatch(error.message, /declares no source named/);
        return true;
      }),
    );
    assert.equal(count(output, /nimbus: source "b" not fetched: no collection in NIMBUS_BUILD_ONLY=sdk reads it\./g), 1, output);
    assert.ok(!existsSync(path.join(site.root, ".nimbus/sources/b")));
  } finally {
    // A failed content sync still writes Astro's data store, on a debounce.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await site.remove();
  }
});
