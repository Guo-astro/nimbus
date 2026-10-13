// Git sources end to end over a bare repository on disk: two collections over
// one source from one snapshot, an API spec from it, the snapshot cache, a
// branch that moves, an annotated tag, the fallback rules when the remote is
// gone, and the author errors that never fall back.

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { build } from "astro";
import { JSDOM } from "jsdom";

import { git, gitRemote } from "./fixtures/git-remote.ts";
import { paritySite, src, type ParitySite } from "./fixtures/parity-site.ts";

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Widgets API", version: "1.0.0" },
  servers: [{ url: "https://api.example.test" }],
  tags: [{ name: "widgets" }],
  paths: {
    "/widgets": {
      get: { operationId: "listWidgets", summary: "List widgets", tags: ["widgets"], responses: { "200": { description: "OK" } } },
    },
  },
};

const REMOTE_FILES = {
  "README.md": "# SDK\n",
  "src/lib.ts": "export const lib = 1;\n",
  "docs/guides/install.md": "---\ntitle: Install\n---\n\nInstall the SDK. Call [list widgets](api.ref:widgets:listWidgets).\n",
  "docs/reference/client.md": "---\ntitle: Client\n---\n\nThe client, version one.\n",
  "docs/openapi.json": `${JSON.stringify(SPEC, null, 2)}\n`,
};

function sourceRoute(collection: string): string {
  return [
    "---",
    `import { getCollectionStaticPaths, getCollectionPage, getEditUrl, getLastUpdated } from ${src("runtime.ts")};`,
    "export const prerender = true;",
    `export const getStaticPaths = getCollectionStaticPaths(${JSON.stringify(collection)});`,
    "const page = await getCollectionPage(Astro);",
    "if (page instanceof Response) return page;",
    "const { entry, Content } = page;",
    'const editUrl = (await getEditUrl(entry)) ?? "no-edit-url";',
    'const lastUpdated = (await getLastUpdated(entry))?.toISOString() ?? "no-date";',
    "---",
    `<html><body><a id="edit" href={editUrl}>{editUrl}</a><time>{lastUpdated}</time><main><Content /></main></body></html>`,
  ].join("\n");
}

const WIDGETS_API = { collection: "widgets", spec: { source: "sdk", path: "docs/openapi.json" } };

async function sourceSite() {
  const site = await paritySite({
    extraCollections: [
      `"sdk-guides": defineCollection(docsCollection({ source: "sdk", base: "guides" }))`,
      `"sdk-reference": defineCollection(docsCollection({ source: "sdk", base: "reference" }))`,
      `widgets: defineCollection(apiCollection())`,
    ],
    routes: {
      "src/pages/sdk-guides/[...slug].astro": sourceRoute("sdk-guides"),
      "src/pages/sdk-reference/[...slug].astro": sourceRoute("sdk-reference"),
      "src/pages/widgets/[...slug].astro": [
        "---",
        `import { getApiStaticPaths } from ${src("runtime.ts")};`,
        "export const prerender = true;",
        `export const getStaticPaths = getApiStaticPaths("widgets");`,
        "---",
        "<html><body>widgets</body></html>",
      ].join("\n"),
    },
  });
  await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
  const remote = await gitRemote(path.join(site.root, "remotes"), REMOTE_FILES);
  const withSdk = (sdk: Record<string, unknown>) => {
    const config = site.configure({ sources: { sdk } });
    const nimbusOptions = (config.integrations![0] as { name: string }).name;
    void nimbusOptions;
    return config;
  };
  return { site, remote, withSdk };
}

/** Build with `sources.sdk` and the widgets spec read from it. */
function configFor(site: ParitySite, sdk: Record<string, unknown>) {
  return site.configure({
    sources: { sdk },
    nimbus: {
      api: [
        {
          collection: "api",
          spec: path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml"),
          label: "SmallCo API",
          routes: { convention: "resource-action-v2" },
        },
        WIDGETS_API,
      ],
    },
  });
}

function snapshotDirs(site: ParitySite): string[] {
  const root = path.join(site.root, ".nimbus/sources/sdk");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((identity) =>
    readdirSync(path.join(root, identity))
      .filter((entry) => /^[0-9a-f]{40}$/.test(entry))
      .map((commit) => `${identity}/${commit}`),
  );
}

const edit = async (site: ParitySite, page: string) =>
  new JSDOM(await site.read(`dist/${page}/index.html`)).window.document.querySelector("#edit")!.textContent;

test("two collections and an API spec build from one pinned snapshot, cached with the remote gone", async () => {
  const { site, remote } = await sourceSite();
  try {
    const sdk = {
      repo: remote.bare,
      ref: remote.first,
      path: "docs",
      editPattern: "https://github.com/acme/sdk/edit/{ref}/{path}",
    };
    await build(configFor(site, sdk));
    assert.equal(snapshotDirs(site).length, 1, "one snapshot for both collections");
    assert.equal(await edit(site, "sdk-guides/install"), `https://github.com/acme/sdk/edit/${remote.first}/docs/guides/install.md`);
    assert.equal(await edit(site, "sdk-reference/client"), `https://github.com/acme/sdk/edit/${remote.first}/docs/reference/client.md`);
    const install = await site.read("dist/sdk-guides/install/index.html");
    assert.match(install, /<time>no-date<\/time>/);
    assert.match(install, /href="\/widgets\//, "citation into the source's spec resolves");
    assert.ok(existsSync(path.join(site.root, "dist/widgets/llms.txt")) || readdirSync(path.join(site.root, "dist/widgets")).length > 0);
    // Only the declared path was checked out.
    const [only] = snapshotDirs(site);
    const snapshot = path.join(site.root, ".nimbus/sources/sdk", only!);
    assert.ok(!existsSync(path.join(snapshot, "src/lib.ts")));
    assert.ok(!existsSync(path.join(snapshot, ".git")));

    // The remote is gone: a pinned commit is a cache hit.
    await rename(remote.bare, `${remote.bare}.gone`);
    await build(configFor(site, sdk));
    assert.match(await site.read("dist/sdk-reference/client/index.html"), /version one/);
  } finally {
    await site.remove();
  }
});

test("a branch picks up a new commit, an annotated tag peels, and a branch outage builds the same identity's snapshot", async () => {
  const { site, remote } = await sourceSite();
  try {
    const branch = { repo: remote.bare, ref: "main", path: "docs" };
    await build(configFor(site, branch));
    assert.match(await site.read("dist/sdk-reference/client/index.html"), /version one/);

    const second = await remote.commit({ "docs/reference/client.md": "---\ntitle: Client\n---\n\nThe client, version two.\n" });
    await build(configFor(site, branch));
    assert.match(await site.read("dist/sdk-reference/client/index.html"), /version two/);
    // The first commit's snapshot was pruned: only the selected one stays.
    assert.deepEqual(snapshotDirs(site).map((dir) => dir.split("/")[1]), [second]);

    // Outage on `main`: builds from main's selected snapshot.
    await rename(remote.bare, `${remote.bare}.gone`);
    await build(configFor(site, branch));
    assert.match(await site.read("dist/sdk-reference/client/index.html"), /version two/);
    await rename(`${remote.bare}.gone`, remote.bare);

    // An annotated tag resolves to the commit it points at.
    git(remote.work, "tag", "-a", "v2", "-m", "v2");
    git(remote.work, "push", "-q", "origin", "v2");
    await build(configFor(site, { ...branch, ref: "v2" }));
    assert.match(await site.read("dist/sdk-reference/client/index.html"), /version two/);
    // Only the tag's identity is declared now: main's snapshot was pruned.
    assert.equal(snapshotDirs(site).length, 1);
  } finally {
    await site.remove();
  }
});

test("a changed path with the remote gone fails naming the source; a pin-to-branch switch then an outage builds the same commit", async () => {
  const { site, remote } = await sourceSite();
  try {
    await build(configFor(site, { repo: remote.bare, ref: remote.first, path: "docs" }));
    // Same commit through the branch: a new identity, selected on success.
    await build(configFor(site, { repo: remote.bare, ref: "main", path: "docs" }));
    await rename(remote.bare, `${remote.bare}.gone`);
    await build(configFor(site, { repo: remote.bare, ref: "main", path: "docs" }));
    assert.match(await site.read("dist/sdk-reference/client/index.html"), /version one/);
    // A different declaration never builds from another identity's files.
    await assert.rejects(
      build(configFor(site, { repo: remote.bare, ref: "main", path: "" })),
      /could not fetch source "sdk"[\s\S]*no snapshot of this repo, ref and path exists/,
    );
  } finally {
    await site.remove();
  }
});

test("a relative local repo builds, and a path missing at a new commit is an author error that never falls back", async () => {
  const { site, remote } = await sourceSite();
  try {
    const relative = path.relative(site.root, remote.bare);
    assert.ok(!path.isAbsolute(relative));
    await build(configFor(site, { repo: relative, ref: "main", path: "docs" }));
    assert.ok(existsSync(path.join(site.root, "dist/sdk-guides/install/index.html")));
    git(remote.work, "rm", "-r", "-q", "docs");
    git(remote.work, "commit", "-q", "-m", "move docs");
    git(remote.work, "push", "-q", "origin", "main");
    await assert.rejects(
      build(configFor(site, { repo: relative, ref: "main", path: "docs" })),
      /could not check out source "sdk"[\s\S]*path "docs" does not exist/,
    );
  } finally {
    await site.remove();
  }
});

test("a collection base that leaves the source's path is rejected", async () => {
  const site = await paritySite({
    extraCollections: [`escape: defineCollection(docsCollection({ source: "sdk", base: "../src" }))`],
  });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    const remote = await gitRemote(path.join(site.root, "remotes"), REMOTE_FILES);
    await assert.rejects(
      build(site.configure({ sources: { sdk: { repo: remote.bare, ref: "main", path: "docs" } } })),
      /with source, base is a folder inside the source's path and may not be absolute or contain ".."/,
    );
  } finally {
    await site.remove();
  }
});

test("a dev server's snapshot outlives a build that selects a new commit; the next build after it exits prunes it", async () => {
  const { spawn } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { site, remote } = await sourceSite();
  let stop = () => {};
  try {
    const sdk = { repo: remote.bare, ref: "main", path: "docs" };
    const nimbusConfig = {
      site: "https://docs.example.test",
      title: "Parity Docs",
      description: "Dev and build together.",
      search: false,
      sources: { sdk },
      api: [
        { collection: "api", spec: path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml"), label: "SmallCo API", routes: { convention: "resource-action-v2" } },
        WIDGETS_API,
      ],
    };
    await writeFile(
      path.join(site.root, "astro.config.mjs"),
      `import nimbus from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href)};\n` +
        `export default { integrations: [nimbus(${JSON.stringify(nimbusConfig)}, { admonitions: false, sitemap: false, icons: false, validateMdx: false })] };\n`,
    );
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/dev-child.ts", import.meta.url)), site.root],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
    stop = () => child.kill("SIGKILL");
    const port = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", () => {
        const match = /port (\d+)/.exec(out);
        if (match) resolve(match[1]!);
      });
      child.on("exit", (code) => reject(new Error(`dev exited ${code}: ${err}`)));
    });
    const first = snapshotDirs(site);
    assert.equal(first.length, 1);

    const second = await remote.commit({ "docs/reference/client.md": "---\ntitle: Client\n---\n\nThe client, version two.\n" });
    await build(configFor(site, sdk));
    assert.match(await site.read("dist/sdk-reference/client/index.html"), /version two/);
    assert.equal(snapshotDirs(site).length, 2, "the dev server's snapshot survives the build's prune");
    // The dev server keeps serving. Its pages follow Astro's content store,
    // which dev and build share, so they show the build's commit; the lease
    // is what keeps the files it may still import from being deleted.
    const response = await fetch(`http://127.0.0.1:${port}/sdk-reference/client/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /The client, version/);

    child.stdin.end();
    assert.equal(await exited, 0, err);
    await build(configFor(site, sdk));
    assert.deepEqual(snapshotDirs(site).map((dir) => dir.split("/")[1]), [second]);
  } finally {
    stop();
    await site.remove();
  }
});

test("lint names a snapshot problem by source and repository path, and --fix never writes the snapshot", async () => {
  const { spawnSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { site, remote } = await sourceSite();
  try {
    await remote.commit({ "docs/guides/list.mdx": "---\ntitle: List\n---\n\n* one\n* two\n" });
    await build(configFor(site, { repo: remote.bare, ref: "main", path: "docs" }));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)), ...args], {
        cwd: site.root,
        encoding: "utf8",
      });
    const lint = run("lint", "--rule", "nimbus/list-marker-style", "--format", "json");
    const files = (JSON.parse(lint.stdout) as { diagnostics: Array<{ code: string; file: string; line: number }> }).diagnostics
      .filter((d) => d.code === "nimbus/list-marker-style")
      .map((d) => `${d.file}:${d.line}`);
    assert.deepEqual([...new Set(files)], ["sdk: docs/guides/list.mdx:5", "sdk: docs/guides/list.mdx:6"], lint.stderr);

    const [snapshot] = snapshotDirs(site);
    const file = path.join(site.root, ".nimbus/sources/sdk", snapshot!, "docs/guides/list.mdx");
    const before = await readFile(file, "utf8");
    const fix = run("lint", "--rule", "nimbus/list-marker-style", "--fix", "--format", "json");
    assert.equal(await readFile(file, "utf8"), before, "the snapshot stays byte-identical");
    assert.match(fix.stdout, /sdk: docs\/guides\/list\.mdx/, "the fixable finding is still reported");
  } finally {
    await site.remove();
  }
});
