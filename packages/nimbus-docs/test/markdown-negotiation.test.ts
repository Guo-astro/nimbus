import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { dev } from "astro";
import { prefersMarkdown } from "../src/_internal/markdown-negotiation.js";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";

test("Markdown is chosen only when it outranks every HTML and wildcard range", () => {
  for (const [accept, expected] of [
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html;q=0.5, text/markdown;q=0.8, */*;q=0.1", true],
    ["TEXT/Markdown ; q=1", true],
    ["text/markdown, text/html", false],
    ["text/markdown;q=0.8, */*", false],
    ["text/markdown;q=0.5, text/*;q=0.5", false],
    ["text/markdown;q=0", false],
    ["text/markdown;q=0, text/html;q=0", false],
    ["*/*", false],
    ["text/html", false],
    ["text/plain", false],
    ["text/markdown;q=abc", false],
    ["text/markdown;q=2", false],
    ["text/markdown;q=0x1, text/html;q=0.9", false],
    ["text/markdown;q=.9, text/html;q=0.5", false],
    ["text/markdown;q = 0", false],
    ["text/markdown;q = 0.9, text/html;q=0.5", true],
    ["garbage", false],
    ["", false],
    [null, false],
  ] as const) {
    assert.equal(prefersMarkdown(accept), expected, `Accept: ${String(accept)}`);
  }
});

test("on server output a request-rendered page and the homepage negotiate; everything else passes through", async () => {
  const site = await fixture(
    "---\ntitle: Root entry\n---\nHome body.",
    "docs",
    false,
    { rendering: { default: "request" } },
  );
  const index = pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href;
  await site.write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${JSON.stringify(index)};\nexport const getStaticPaths = getDocsStaticPaths("docs");\nAstro.response.headers.set("Vary", "Cookie");\nAstro.response.headers.set("X-Owner", "page");\n---\n<html><body>Page</body></html>`,
  );
  await site.write("src/content/docs/café.mdx", "---\ntitle: Café\n---\nAccents too.");
  const server = await dev({ ...site.config, output: "server", server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const markdown = { Accept: "text/markdown, text/html;q=0.9" };
    const encoded = await fetch(`${origin}/docs/caf%C3%A9/`, { headers: markdown });
    assert.match(encoded.headers.get("Content-Type") ?? "", /text\/markdown/, "percent-encoded URL");
    const page = await fetch(`${origin}/docs/guide/`, { headers: markdown });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.equal(page.headers.get("Vary"), "Cookie, Accept");
    assert.equal(await page.text(), await (await fetch(`${origin}/docs/guide/index.md`)).text());
    const html = await fetch(`${origin}/docs/guide/`, { headers: { Accept: "*/*" } });
    assert.match(html.headers.get("Content-Type") ?? "", /text\/html/);
    assert.match(html.headers.get("Vary") ?? "", /(^|, )Accept$/);
    // A page's own Vary and other headers survive both forms.
    const owned = await fetch(`${origin}/docs/guide/`, { headers: markdown });
    assert.equal(owned.headers.get("X-Owner"), "page");
    assert.match(owned.headers.get("Vary") ?? "", /^Cookie, Accept$/);
    const head = await fetch(`${origin}/docs/guide/`, { method: "HEAD", headers: markdown });
    assert.match(head.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.equal(await head.text(), "");
    const home = await fetch(`${origin}/docs/`, { headers: markdown });
    assert.match(home.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.equal(home.headers.get("Vary"), "Accept");
    assert.equal(await home.text(), await (await fetch(`${origin}/docs/index.md`)).text());
    const homeHtml = await fetch(`${origin}/docs/`);
    assert.equal(home.headers.get("Link"), homeHtml.headers.get("Link"));
    assert.match(home.headers.get("Link") ?? "", /rel="help".*rel="ard"/);
    // Endpoints, assets, and a URL no entry owns pass through untouched.
    for (const route of ["/docs/llms.txt", "/docs/guide/index.md", "/docs/.well-known/ard.json", "/docs/nowhere/"]) {
      const response = await fetch(origin + route, { headers: markdown });
      assert.equal(response.status, 200, route);
      assert.doesNotMatch(response.headers.get("Vary") ?? "", /Accept/, route);
      assert.doesNotMatch(response.headers.get("Content-Type") ?? "", route.endsWith("/") ? /markdown/ : /html/, route);
    }
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true });
  }
});

test("under server output, build-rendered pages and the homepage of an all-build site stay HTML", async () => {
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.", "docs", false, {
    rendering: { collections: { docs: "build" } },
  });
  const index = pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href;
  await site.write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${JSON.stringify(index)};\nexport const getStaticPaths = getDocsStaticPaths("docs");\n---\n<html><body>Page</body></html>`,
  );
  const server = await dev({ ...site.config, output: "server", server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    for (const route of ["/docs/guide/", "/docs/"]) {
      const response = await fetch(origin + route, { headers: { Accept: "text/markdown" } });
      assert.match(response.headers.get("Content-Type") ?? "", /text\/html/, route);
      assert.doesNotMatch(response.headers.get("Vary") ?? "", /Accept/, route);
    }
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a static site never negotiates", async () => {
  const site = await fixture("---\ntitle: Root entry\n---\nHome body.");
  const server = await dev({ ...site.config, server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const home = await fetch(`${origin}/docs/`, { headers: { Accept: "text/markdown" } });
    assert.match(home.headers.get("Content-Type") ?? "", /text\/html/);
    assert.doesNotMatch(home.headers.get("Vary") ?? "", /Accept/);
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true });
  }
});
