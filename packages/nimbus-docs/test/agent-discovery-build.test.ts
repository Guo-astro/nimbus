import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";

test("real Astro builds reuse llms bytes and preserve owner headers under a base", async () => {
  const site = await fixture();
  try {
    await build(site.config);
    assert.equal(
      await site.read("dist/index.md"),
      await site.read("dist/llms.txt"),
    );
    const ard = await site.read("dist/.well-known/ard.json");
    assert.equal(ard, await site.read("dist/.well-known/ai-catalog.json"));
    const document = JSON.parse(ard);
    assert.deepEqual(
      document.entries.map((entry: { url: string }) => entry.url),
      [
        "https://example.test/docs/llms.txt",
        "https://example.test/docs/index.md",
      ],
    );
    assert.ok(
      (await site.read("dist/_headers")).startsWith(
        await site.read("public/_headers"),
      ),
    );
    assert.match(await site.read("dist/_headers"), /rel="ard"/);
    await site.write(
      "src/content/docs/guide.mdx",
      "---\ntitle: New title\n---\nNew discovery text.",
    );
    await build(site.config);
    assert.match(await site.read("dist/index.md"), /New title/);
    assert.equal(
      (await site.read("dist/_headers")).match(/# Nimbus agent discovery/g)
        ?.length,
      1,
    );
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a real root entry wins over llms, while noindex excludes only its discovery link", async () => {
  const site = await fixture(
    "---\ntitle: Root entry\nnoindex: true\n---\nUnique homepage body.",
  );
  try {
    await build(site.config);
    assert.match(await site.read("dist/index.md"), /Unique homepage body/);
    assert.doesNotMatch(await site.read("dist/llms.txt"), /Root entry/);
    const document = JSON.parse(await site.read("dist/.well-known/ard.json"));
    assert.deepEqual(
      document.entries.map((entry: { type: string }) => entry.type),
      ["text/plain"],
    );
    assert.doesNotMatch(await site.read("dist/_headers"), /rel="alternate"/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("an existing public discovery document fails visibly instead of being overwritten", async () => {
  const site = await fixture();
  try {
    const owner = '{"entries": [{"url": "https://example.net/custom"}]}';
    await site.write("assets/.well-known/ard.json", owner);
    await assert.rejects(
      build({ ...site.config, publicDir: "./assets" }),
      /Move your existing discovery document at assets[/\\]\.well-known[/\\]ard\.json/,
    );
    assert.equal(await site.read("assets/.well-known/ard.json"), owner);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a noindex entry in another collection does not hide the llms homepage fallback", async () => {
  const site = await fixture(
    "---\ntitle: Handbook\nnoindex: true\n---\nHandbook body.",
    "handbook",
  );
  try {
    await build(site.config);
    assert.equal(
      await site.read("dist/index.md"),
      await site.read("dist/llms.txt"),
    );
    assert.match(await site.read("dist/handbook/index.md"), /Handbook body/);
    assert.match(
      await site.read("dist/.well-known/ard.json"),
      /text\/markdown/,
    );
    assert.match(await site.read("dist/_headers"), /rel="alternate"/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("owner homepage Markdown and llms fallback do not inherit an unused root entry's noindex", async () => {
  for (const owner of [false, true]) {
    const site = await fixture(
      "---\ntitle: Unused root\nnoindex: true\n---\nUnused body.",
    );
    try {
      await rm(path.join(site.root, "src/pages/[...slug]/index.md.ts"));
      if (owner)
        await site.write("public/index.md", "Owner homepage Markdown.");
      await build(site.config);
      assert.equal(
        await site.read("dist/index.md"),
        owner ? "Owner homepage Markdown." : await site.read("dist/llms.txt"),
      );
      assert.match(
        await site.read("dist/.well-known/ard.json"),
        /text\/markdown/,
      );
      assert.match(await site.read("dist/_headers"), /rel="alternate"/);
    } finally {
      await rm(site.root, { recursive: true, force: true });
    }
  }
});

test("API discovery links follow the document trailing-slash policy under a base", async () => {
  const site = await fixture(undefined, "docs", true);
  try {
    const api = pathToFileURL(
      path.resolve(import.meta.dirname, "../src/runtime.ts"),
    ).href;
    await site.write(
      "src/pages/pets/[...slug].astro",
      `---
import { getApiStaticPaths } from ${JSON.stringify(api)};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("pets");
---
<html><body>Pets API</body></html>`,
    );
    for (const [trailingSlash, format, suffix] of [
      ["never", "directory", ""],
      ["always", "directory", "/"],
      ["ignore", "file", ""],
    ] as const) {
      await build({ ...site.config, trailingSlash, build: { format } });
      const headers = await site.read("dist/_headers");
      const links = headers
        .split("\n")
        .filter((line) => line.includes('rel="service-doc"'));
      assert.ok(links.length);
      assert.ok(
        links.every(
          (line) =>
            line ===
            `  Link: <https://example.test/docs/pets${suffix}>; rel="service-doc"; type="text/html"`,
        ),
        headers,
      );
      assert.match(
        await site.read(
          format === "file" ? "dist/pets.html" : "dist/pets/index.html",
        ),
        /Pets API/,
      );
    }
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});
