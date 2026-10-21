// `astro dev` follows a collection's route file: moving it restarts the server
// onto the new URL and logs the redirect to add; a folder rename or a burst of
// moves settles in at most two restarts; a template edit or an unrelated
// route doesn't restart; a move that leaves routes ambiguous prints the error
// and keeps the previous config until it's fixed.

import assert from "node:assert/strict";
import { appendFile, mkdir, rename, rm } from "node:fs/promises";
import { test } from "node:test";

import { moduleUrl, settle, until, withDevSite } from "./fixtures/dev-site.ts";

const SDK_ROUTE = `---
import { getCollectionPage, getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const getStaticPaths = getCollectionStaticPaths("sdk");
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
---
<html><body><main>sdk:{page.entry.id}</main></body></html>
`;

test("dev restarts when a route file moves a collection, and only then", { timeout: 240_000 }, async () => {
  const files = {
    "src/content.config.ts": `import { defineCollection } from "astro:content";
import { docsCollection } from ${moduleUrl("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ base: "sdk" })),
};`,
    "src/content/docs/index.mdx": "---\ntitle: Home\n---\nHome.\n",
    "src/content/sdk/setup.mdx": "---\ntitle: Setup\n---\nSet it up.\n",
    "src/pages/sdk/[...slug].astro": SDK_ROUTE,
  };
  await withDevSite(files, {}, async ({ file, write, page, serves: servesText, since, restartsSince, restarted, mark: now }) => {
    const serves = (route: string) => servesText(route, "sdk:setup");
    await serves("/sdk/setup/");

    let mark = now();
    await rename(file("src/pages/sdk"), file("src/pages/kit"));
    await serves("/kit/setup/");
    await restarted(mark);
    assert.equal((await page("/sdk/setup/")).status, 404);
    assert.match(since(mark), /collection "sdk" moved from \/sdk to \/kit\. Redirect its old URLs in astro\.config: "\/sdk\/\[\.\.\.slug\]": "\/kit\/\[\.\.\.slug\]"\./);
    assert.ok(restartsSince(mark) >= 1 && restartsSince(mark) <= 2, since(mark));

    mark = now();
    await rename(file("src/pages/kit"), file("src/pages/a"));
    await rename(file("src/pages/a"), file("src/pages/b"));
    await mkdir(file("src/pages/products"));
    await rename(file("src/pages/b"), file("src/pages/products/kit"));
    await serves("/products/kit/setup/");
    await restarted(mark);
    await settle(1500);
    assert.ok(restartsSince(mark) >= 1 && restartsSince(mark) <= 2, since(mark));

    mark = now();
    await appendFile(file("src/pages/products/kit/[...slug].astro"), "<!-- edited -->\n");
    await write("src/pages/tags/[tag].astro", "---\nexport const getStaticPaths = () => [];\n---\n<p>tag</p>\n");
    await settle(1500);
    assert.equal(restartsSince(mark), 0, since(mark));
    await serves("/products/kit/setup/");

    mark = now();
    await write("src/pages/copy/[...slug].astro", SDK_ROUTE);
    await until("the two-routes error", () => since(mark), (text) => /collection "sdk" is served by 2 routes, none at \/sdk/.test(text));
    assert.match(since(mark), /Continuing with previous valid configuration/);
    await serves("/products/kit/setup/");

    mark = now();
    await rm(file("src/pages/copy"), { recursive: true });
    await restarted(mark);
    await serves("/products/kit/setup/");
  });
});
