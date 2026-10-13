// The git row of both parity fixtures: a collection over a git source renders
// Markdown and MDX exactly as a local glob does, collides like one, and is
// validated and linted like one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "astro";
import { JSDOM } from "jsdom";

import { gitRemote } from "./fixtures/git-remote.ts";
import { pageRoute, paritySite } from "./fixtures/parity-site.ts";

const markdown = (title: string, slug?: string) =>
  [
    "---",
    `title: ${title}`,
    ...(slug ? [`slug: ${slug}`] : []),
    "---",
    "",
    `## ${title} overview`,
    "",
    "Some text with a [link to setup](/setup/) and a [create call](api.ref:api:create).",
    "",
    "| Key | Value |",
    "|---|---|",
    "| a | 1 |",
    "",
    "```js",
    "console.log(1);",
    "```",
    "",
    "![Logo](https://example.test/logo.png)",
    "",
  ].join("\n");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);
const MDX = [
  "---",
  "title: Page",
  "---",
  'import Local from "./Local.astro";',
  'import { z } from "astro/zod";',
  'export const checked = z.string().parse("zod ok");',
  "",
  ":::note[Heads up]",
  "Callout body.",
  ":::",
  "",
  '<Badge text="global" />',
  "",
  "<Local />",
  "",
  "{checked}",
  "",
  "![Pic](./pic.png)",
  "",
  "A [create call](api.ref:api:create) and [setup](/setup/).",
  "",
].join("\n");

const main = (html: string) => new JSDOM(html).window.document.querySelector("main")!.innerHTML;

test("Markdown from a git source renders, twins and indexes like a local glob; a duplicate slug there fails", async () => {
  const site = await paritySite({
    extraCollections: [`git: defineCollection(docsCollection({ source: "sdk" }))`],
    routes: { "src/pages/git/[...slug].astro": pageRoute("git") },
  });
  try {
    const pages = { "guide-file.md": markdown("Guide", "guide"), "setup.md": markdown("Setup") };
    for (const [file, body] of Object.entries(pages)) await site.write(`src/content/docs/${file}`, body);
    const remote = await gitRemote(
      path.join(site.root, "remotes"),
      Object.fromEntries(Object.entries(pages).map(([file, body]) => [`docs/${file}`, body])),
    );
    const sdk = { repo: remote.bare, ref: "main", path: "docs" };
    await build(site.configure({ sources: { sdk } }));
    for (const id of ["guide", "setup"]) {
      assert.equal(main(await site.read(`dist/git/${id}/index.html`)), main(await site.read(`dist/${id}/index.html`)), id);
      const twin = (await site.read(`dist/git/${id}/index.md`)).replace("docs.example.test/git/", "docs.example.test/");
      assert.equal(twin, await site.read(`dist/${id}/index.md`), `${id} twin`);
    }
    assert.match(await site.read("dist/git/llms.txt"), /https:\/\/docs\.example\.test\/git\/setup\/index\.md/);

    await remote.commit({ "docs/other.md": markdown("Other", "setup") });
    await assert.rejects(build(site.configure({ sources: { sdk } })), /\/git\/setup\s+←\s+.*docs\/(setup|other)\.md, .*docs\/(setup|other)\.md/);
  } finally {
    await site.remove();
  }
});

test("MDX from a git source renders like a local glob, fails component validation and is linted", async () => {
  const site = await paritySite({
    components: true,
    integration: { admonitions: {}, validateMdx: true },
    extraCollections: [`git: defineCollection(docsCollection({ source: "sdk" }))`],
    routes: { "src/pages/git/[...slug].astro": pageRoute("git", true) },
  });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    await site.write("src/content/docs/page.mdx", MDX);
    await site.write("src/content/docs/Local.astro", `<em class="local">local component</em>\n`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(site.root, "src/content/docs/pic.png"), PNG);
    const remote = await gitRemote(path.join(site.root, "remotes"), {
      "docs/page.mdx": MDX,
      "docs/Local.astro": `<em class="local">local component</em>\n`,
      "docs/pic.png": PNG.toString("latin1"),
    });
    // The fixture writes text; put the real PNG bytes in and commit them.
    await writeFile(path.join(remote.work, "docs/pic.png"), PNG);
    await remote.commit({}, "binary png");
    const sdk = { repo: remote.bare, ref: "main", path: "docs" };
    await build({
      ...site.configure({ sources: { sdk } }),
      image: { service: { entrypoint: "astro/assets/services/noop" } },
    });
    const git = main(await site.read("dist/git/page/index.html"));
    assert.equal(git, main(await site.read("dist/page/index.html")));
    assert.match(git, /aria-label="Heads up"/);
    assert.match(git, /class="local"/);
    assert.match(git, /zod ok/);

    // Lint reads the snapshot the build selected.
    await remote.commit({ "docs/heads.mdx": "---\ntitle: Heads\n---\n\n# One\n\n# Two\n" });
    await build({
      ...site.configure({ sources: { sdk } }),
      image: { service: { entrypoint: "astro/assets/services/noop" } },
    });
    const lint = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)), "lint", "--rule", "nimbus/single-h1", "--format", "json"],
      { cwd: site.root, encoding: "utf8" },
    );
    const files = (JSON.parse(lint.stdout) as { diagnostics: Array<{ code: string; file: string }> }).diagnostics
      .filter((d) => d.code === "nimbus/single-h1")
      .map((d) => d.file);
    assert.deepEqual(files, ["sdk: docs/heads.mdx"], lint.stderr);

    await remote.commit({ "docs/broken.mdx": "---\ntitle: Broken\n---\n\n<Nope />\n" });
    await assert.rejects(
      build({ ...site.configure({ sources: { sdk } }), image: { service: { entrypoint: "astro/assets/services/noop" } } }),
      /Nope/,
    );
    void readFileSync;
  } finally {
    await site.remove();
  }
});
