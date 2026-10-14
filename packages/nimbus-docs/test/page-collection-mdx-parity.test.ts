// The page-collection contract for MDX: a page in a folder outside `src/`
// gets callouts, global and relative components, Astro's image pipeline,
// citations, links and component validation exactly as a page under
// `src/content` does, in a build and in a running dev server.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { build, dev } from "astro";
import { JSDOM } from "jsdom";

import { paritySite, type ParitySite } from "./fixtures/parity-site.ts";

// A 2x2 PNG, so Astro's image service has something real to optimise.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);

const PAGE = [
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

const FOLDERS = ["src/content/docs", "external/ext"];

async function writePages(site: ParitySite, extra: Record<string, string> = {}) {
  await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
  for (const folder of FOLDERS) {
    await site.write(`${folder}/page.mdx`, PAGE);
    await site.write(`${folder}/Local.astro`, `<em class="local">local component</em>\n`);
    await writeFile(path.join(site.root, folder, "pic.png"), PNG);
    for (const [file, body] of Object.entries(extra)) await site.write(`${folder}/${file}`, body);
  }
}

function main(html: string) {
  return new JSDOM(html).window.document.querySelector("main")!;
}

test("an MDX page renders the same from a local glob and a glob outside src/", async () => {
  const site = await paritySite({ components: true, integration: { admonitions: {}, validateMdx: true } });
  try {
    await writePages(site);
    // This package has no Sharp; the no-op service still runs the pipeline
    // (import, hash, emit) that a relative image goes through.
    await build({ ...site.config, image: { service: { entrypoint: "astro/assets/services/noop" } } });
    const docs = main(await site.read("dist/page/index.html"));
    const ext = main(await site.read("dist/ext/page/index.html"));
    assert.equal(ext.innerHTML, docs.innerHTML);
    assert.equal(docs.querySelector("aside")?.getAttribute("aria-label"), "Heads up");
    assert.equal(docs.querySelector(".badge")?.textContent, "global");
    assert.equal(docs.querySelector(".local")?.textContent, "local component");
    assert.match(docs.textContent!, /zod ok/);
    assert.match(docs.querySelector("img")!.getAttribute("src")!, /^\/_astro\/pic\.[\w-]+\.png$/);
    assert.match(docs.innerHTML, /href="\/api\//);
    assert.doesNotMatch(docs.innerHTML, /api\.ref:/);
  } finally {
    await site.remove();
  }
});

test("an unknown component fails MDX validation in a page outside src/", async () => {
  const site = await paritySite({ components: true, integration: { admonitions: {}, validateMdx: true } });
  try {
    await writePages(site);
    await site.write("external/ext/broken.mdx", "---\ntitle: Broken\n---\n\n<Nope />\n");
    await assert.rejects(build(site.config), /Nope[\s\S]*external\/ext\/broken\.mdx|external\/ext\/broken\.mdx[\s\S]*Nope/);
  } finally {
    await site.remove();
  }
});

test("a callout renders for an MDX file added outside src/ while the dev server runs", async () => {
  const site = await paritySite({ components: true, integration: { admonitions: {} } });
  try {
    await writePages(site);
    const server = await dev({ ...site.config, server: { port: 0, host: "127.0.0.1" } });
    try {
      const address = server.address;
      const base = `http://127.0.0.1:${address.port}`;
      const before = await fetch(`${base}/ext/page/`);
      assert.equal(before.status, 200);
      await site.write("external/ext/added.mdx", "---\ntitle: Added\n---\n\n:::tip[Added callout]\nNew file.\n:::\n");
      let html = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fetch(`${base}/ext/added/`);
        html = await response.text();
        if (response.status === 200 && html.includes("Added callout")) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const aside = main(html).querySelector("aside");
      assert.equal(aside?.getAttribute("aria-label"), "Added callout", html.slice(0, 500));
      assert.equal(aside?.getAttribute("data-type"), "tip");
    } finally {
      await server.stop();
    }
  } finally {
    await site.remove();
  }
});

test("lint and check read a page collection outside src/ and name the in-memory one", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const tsx = import.meta.resolve("tsx");
  const site = await paritySite({ components: true, memory: [{ id: "m", title: "M", body: "M." }] });
  try {
    await writePages(site);
    // A second top-level heading in each on-disk row.
    for (const folder of FOLDERS) await site.write(`${folder}/heads.mdx`, "---\ntitle: Heads\n---\n\n# One\n\n# Two\n");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd: site.root, encoding: "utf8" });

    const lint = run("lint", "--rule", "nimbus/single-h1", "--format", "json");
    const files = (JSON.parse(lint.stdout) as { diagnostics: Array<{ code: string; file: string }> }).diagnostics
      .filter((d) => d.code === "nimbus/single-h1")
      .map((d) => d.file)
      .sort();
    assert.deepEqual(files, ["external/ext/heads.mdx", "src/content/docs/heads.mdx"], lint.stderr);
    assert.match(lint.stderr, /not inspected: mem/);

    // `check` finds a duplicate slug across the outside folder statically.
    await site.write("external/ext/dup.mdx", "---\ntitle: Dup\nslug: heads\n---\n\nDup.\n");
    const check = run("check", "--structure", "--format", "json");
    assert.match(check.stdout, /\/ext\/heads is claimed by more than one source \(external\/ext\/dup\.mdx, external\/ext\/heads\.mdx|\/ext\/heads is claimed by more than one source \(external\/ext\/heads\.mdx, external\/ext\/dup\.mdx/, check.stdout + check.stderr);
  } finally {
    await site.remove();
  }
});
