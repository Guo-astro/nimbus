// `astro dev` follows a collection's route file: moving it restarts the server
// onto the new URL and logs the redirect to add; a folder rename or a burst of
// moves settles in at most two restarts; a template edit or an unrelated
// route doesn't restart; a move that leaves routes ambiguous prints the error
// and keeps the previous config until it's fixed.

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { dev } from "astro";

import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })));
});

const SRC = path.resolve(import.meta.dirname, "../src");
const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(path.join(SRC, relative)).href);

const ASTRO_CONFIG = `import nimbus from ${moduleUrl("index.ts")};

export default {
  cacheDir: "./.astro",
  vite: {
    cacheDir: "./.vite",
    logLevel: "silent",
    resolve: {
      alias: [
        { find: /^@cloudflare\\/nimbus-docs$/, replacement: ${JSON.stringify(path.join(SRC, "index.ts"))} },
        { find: /^@cloudflare\\/nimbus-docs\\//, replacement: ${JSON.stringify(`${SRC}/`)} },
      ],
    },
  },
  integrations: [
    nimbus(
      { site: "https://dev.test", title: "Dev", description: "Dev", search: false },
      { admonitions: false, sitemap: false, validateMdx: false },
    ),
  ],
};
`;

const SDK_ROUTE = `---
import { getCollectionPage, getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";
export const getStaticPaths = getCollectionStaticPaths("sdk");
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
---
<html><body><main>sdk:{page.entry.id}</main></body></html>
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function until<T>(describe: string, read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${describe}; last value: ${JSON.stringify(last)}`);
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("dev restarts when a route file moves a collection, and only then", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-collection-urls-dev-"));
  roots.push(root);
  const file = (relative: string) => path.join(root, relative);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), contents, "utf8");
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), file("node_modules"), process.platform === "win32" ? "junction" : "dir");
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write("astro.config.mjs", ASTRO_CONFIG);
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { docsCollection } from ${moduleUrl("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ base: "sdk" })),
};`,
  );
  await write("src/content/docs/index.mdx", "---\ntitle: Home\n---\nHome.\n");
  await write("src/content/sdk/setup.mdx", "---\ntitle: Setup\n---\nSet it up.\n");
  await write("src/pages/sdk/[...slug].astro", SDK_ROUTE);

  const logs: string[] = [];
  const streams = [process.stdout, process.stderr] as const;
  const realWrites = streams.map((stream) => stream.write);
  for (const [index, stream] of streams.entries()) {
    const realWrite = realWrites[index]!.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return realWrite(chunk, ...rest);
    }) as typeof stream.write;
  }
  const since = (mark: number) => logs.slice(mark).join("");
  const restartsSince = (mark: number) => since(mark).match(/Restarting\.\.\./gu)?.length ?? 0;
  // A restart re-syncs content once setup has run; wait for it, so the next
  // step (or stopping the server) doesn't race it.
  const restarted = (mark: number) =>
    until("the restart to finish", () => since(mark), (text) => {
      const start = text.lastIndexOf("Restarting...");
      return start >= 0 && text.indexOf("Synced content", start) > start;
    });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = await dev({ root: pathToFileURL(`${root}${path.sep}`), logLevel: "info", server: { host: "127.0.0.1", port } });
  const page = async (route: string) => {
    const response = await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    return { status: response?.status ?? 0, body: (await response?.text()) ?? "" };
  };
  const serves = (route: string) => until(`${route} to serve the sdk page`, () => page(route), ({ status, body }) => status === 200 && body.includes("sdk:setup"));

  try {
    await serves("/sdk/setup/");

    let mark = logs.length;
    await rename(file("src/pages/sdk"), file("src/pages/kit"));
    await serves("/kit/setup/");
    await restarted(mark);
    assert.equal((await page("/sdk/setup/")).status, 404);
    assert.match(since(mark), /collection "sdk" moved from \/sdk to \/kit\. Redirect its old URLs in astro\.config: "\/sdk\/\[\.\.\.slug\]": "\/kit\/\[\.\.\.slug\]"\./);
    assert.ok(restartsSince(mark) >= 1 && restartsSince(mark) <= 2, since(mark));

    mark = logs.length;
    await rename(file("src/pages/kit"), file("src/pages/a"));
    await rename(file("src/pages/a"), file("src/pages/b"));
    await mkdir(file("src/pages/products"));
    await rename(file("src/pages/b"), file("src/pages/products/kit"));
    await serves("/products/kit/setup/");
    await restarted(mark);
    await settle(1500);
    assert.ok(restartsSince(mark) >= 1 && restartsSince(mark) <= 2, since(mark));

    mark = logs.length;
    await appendFile(file("src/pages/products/kit/[...slug].astro"), "<!-- edited -->\n");
    await write("src/pages/tags/[tag].astro", "---\nexport const getStaticPaths = () => [];\n---\n<p>tag</p>\n");
    await settle(1500);
    assert.equal(restartsSince(mark), 0, since(mark));
    await serves("/products/kit/setup/");

    mark = logs.length;
    await write("src/pages/copy/[...slug].astro", SDK_ROUTE);
    await until("the two-routes error", () => since(mark), (text) => /collection "sdk" is served by 2 routes, none at \/sdk/.test(text));
    assert.match(since(mark), /Continuing with previous valid configuration/);
    await serves("/products/kit/setup/");

    mark = logs.length;
    await rm(file("src/pages/copy"), { recursive: true });
    await restarted(mark);
    await serves("/products/kit/setup/");
  } finally {
    await server.stop();
    for (const [index, stream] of streams.entries()) stream.write = realWrites[index]!;
  }
});
