// In `astro dev`, editing a placed collection's `index` page under
// `src/content` changes its group in the enclosing folder's sidebar on the
// next request, without a restart.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

const route = (collection: string) => `---
import { getCollectionPage, getCollectionStaticPaths, getSidebar } from "@cloudflare/nimbus-docs/runtime";
export const getStaticPaths = getCollectionStaticPaths(${JSON.stringify(collection)});
const page = await getCollectionPage(Astro);
if (page instanceof Response) return page;
const labels = [];
const walk = (items) => { for (const item of items) { labels.push(item.label); if (item.type === "group") walk(item.children); } };
walk(await getSidebar(Astro.url.pathname, { collection: ${JSON.stringify(collection)} }));
---
<html><body><main data-labels={JSON.stringify(labels)}>page</main></body></html>
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

test("editing a placed collection's index page shows on reload", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-nested-nav-dev-"));
  roots.push(root);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write("astro.config.mjs", ASTRO_CONFIG);
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { docsCollection } from ${moduleUrl("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  dbt: defineCollection(docsCollection({ base: "dbt" })),
};`,
  );
  await write("src/content/docs/index.mdx", "---\ntitle: Home\n---\nHome.\n");
  await write("src/content/docs/integrations/kafka.mdx", "---\ntitle: Kafka\nsidebar:\n  order: 2\n---\nKafka.\n");
  await write("src/content/dbt/index.mdx", "---\ntitle: dbt\n---\ndbt.\n");
  await write("src/content/dbt/setup.mdx", "---\ntitle: Setup\n---\nSet it up.\n");
  await write("src/pages/[...slug].astro", route("docs"));
  await write("src/pages/integrations/dbt/[...slug].astro", route("dbt"));

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = await dev({ root: pathToFileURL(`${root}${path.sep}`), logLevel: "silent", server: { host: "127.0.0.1", port } });
  const labels = async () => {
    const response = await fetch(`${origin}/integrations/kafka/`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    const match = /data-labels="([^"]*)"/.exec((await response?.text()) ?? "");
    return match ? (JSON.parse(match[1]!.replaceAll("&quot;", '"')) as string[]) : [];
  };

  try {
    await until("dbt after Kafka", labels, (value) => value.join() === "Integrations,Kafka,dbt,Setup");
    await write("src/content/dbt/index.mdx", "---\ntitle: dbt Core\nsidebar:\n  order: 1\n---\ndbt.\n");
    await until("dbt Core before Kafka", labels, (value) => value.join() === "Integrations,dbt Core,Setup,Kafka");
  } finally {
    await server.stop();
  }
});
