import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { dev } from "astro";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";

test("dev content edits refresh homepage Markdown, discovery headers and ARD", async () => {
  const site = await fixture();
  const server = await dev({
    ...site.config,
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const home = await fetch(origin + "/docs/");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("Link") ?? "", /rel="help"/);
    assert.match(home.headers.get("Link") ?? "", /rel="ard"/);
    const markdown = await fetch(origin + "/docs/index.md");
    assert.equal(markdown.status, 200, await markdown.clone().text());
    assert.match(markdown.headers.get("Content-Type") ?? "", /text\/markdown/);
    assert.equal(
      await markdown.text(),
      await (await fetch(origin + "/docs/llms.txt")).text(),
    );
    const ard = await fetch(origin + "/.well-known/ard.json");
    assert.equal(ard.status, 200);
    assert.equal(ard.headers.get("Access-Control-Allow-Origin"), "*");
    const body = (hidden: boolean) =>
      `---\ntitle: Root\nnoindex: ${hidden}\n---\nRevision ${hidden}.`;
    for (const hidden of [false, true, false]) {
      await site.write("src/content/docs/index.mdx", body(hidden));
      const deadline = Date.now() + 10000;
      let committed = false;
      let content = "";
      while (Date.now() < deadline) {
        content = await (await fetch(origin + "/docs/index.md")).text();
        if (content.includes(`Revision ${hidden}.`)) {
          committed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(
        committed,
        `updated prepared Markdown was not served: ${content}`,
      );
      const links = (await fetch(origin + "/docs/")).headers.get("Link") ?? "";
      assert.equal(links.includes('rel="alternate"'), !hidden);
      const updatedArd = await (
        await fetch(origin + "/.well-known/ard.json")
      ).json();
      assert.equal(
        updatedArd.entries.some(
          (entry: { type: string }) => entry.type === "text/markdown",
        ),
        !hidden,
      );
      // Astro debounces persistence and may still be syncing after a response.
      // Wait for this edit to persist before editing again or removing the root.
      let persisted = false;
      while (Date.now() < deadline) {
        const store = await site.read(".astro/data-store.json").catch(() => "");
        if (
          store.includes(`Revision ${hidden}.`) &&
          !store.includes(`Revision ${!hidden}.`)
        ) {
          persisted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(persisted, "content edit was not persisted");
    }
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true });
  }
});
