// A draft from a loader with no files, in `astro dev`: a page with its body.
// Its own file, because a dev server and a build in one process share module
// state.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dev } from "astro";

import { paritySite } from "./fixtures/parity-site.ts";

test("a loader's draft is a page in dev, with its body", async () => {
  const site = await paritySite({ memory: [{ id: "drafted", title: "Drafted", body: "Drafted first.\n", draft: true }] });
  try {
    await site.write("src/content/docs/index.md", "---\ntitle: Home\n---\n\nHome.\n");
    const server = await dev({ ...site.config, server: { port: 0, host: "127.0.0.1" } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address.port}/mem/drafted/`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Drafted first\./);
    } finally {
      await server.stop();
    }
  } finally {
    await site.remove();
  }
});
