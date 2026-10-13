// The remote MCP server end to end: a server build for the Cloudflare
// adapter (by name; the Workers binding is stubbed to read the client
// directory) with current, deprecated and hidden docs versions, a noindex
// page, a noindex-but-searchable page, a blog and a query-versioned API.
// Then the handshake, both tools, parity with llms.txt and search's rule,
// the card, discovery, headers, and the static-build author error.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";

import { build, type AstroIntegration } from "astro";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";
import { INITIALIZE_PARAMS, readRpcResponse, rpcRequest, toolText } from "./fixtures/mcp/rpc.js";

register(new URL("./fixtures/mcp/workers-loader.mjs", import.meta.url));

const SRC_DIR = path.resolve(import.meta.dirname, "../src");
const srcModule = (relative: string) => JSON.stringify(pathToFileURL(path.join(SRC_DIR, relative)).href);
const assetRoots = ((globalThis as { __nimbusTestAssetRoots?: Map<string, { dir: string; base: string }> }).__nimbusTestAssetRoots ??= new Map());

function spec(version: string, ops: Array<[string, string, string]>): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, p, operationId] of ops) {
    paths[p] = { ...(paths[p] ?? {}), [method]: { operationId, summary: `${operationId} (${version})`, responses: { "200": { description: "ok" } } } };
  }
  return JSON.stringify({ openapi: "3.0.0", info: { title: `QV ${version}`, version: "1.0.0" }, paths });
}

const PAGE = (paths: string) => `---
import { getCollectionStaticPaths, getCollectionPageProps } from ${srcModule("index.ts")};
export const prerender = true;
export const getStaticPaths = ${paths};
const { entry } = await getCollectionPageProps(Astro);
---
<html><body>{entry.id}</body></html>
`;

const API_PAGE = `---
import { getApiRoute, getApiStaticPaths } from ${srcModule("runtime.ts")};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("qv");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
---
<html><body>api</body></html>
`;

interface Site {
  root: string;
  host: string;
  base: string;
  app: { render(request: Request): Promise<Response> };
}

async function buildSite(options: { host: string; base?: string; adapter?: boolean }): Promise<Site> {
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-mcp-"));
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write("specs/v2.json", spec("v2", [["get", "/pets", "list-pets"]]));
  await write("specs/v1.json", spec("v1", [["get", "/pets", "list-pets"]]));
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${srcModule("content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  "docs-v1": defineCollection(docsCollection({ base: "docs-v1" })),
  "docs-v0": defineCollection(docsCollection({ base: "docs-v0" })),
  blog: defineCollection(docsCollection({ base: "blog" })),
  qv: defineCollection(apiCollection()),
};`,
  );
  await write("src/content/docs/index.mdx", "---\ntitle: Home\ndescription: The front page\n---\nWelcome home.\n");
  await write("src/content/docs/guide/index.mdx", "---\ntitle: Guide\ndescription: Start here\n---\n\n## Install\n\nRun the installer.\n");
  await write("src/content/docs/guide/advanced.mdx", "---\ntitle: Advanced\n---\nDeep water.\n");
  await write("src/content/docs/internal.mdx", "---\ntitle: Internal\nnoindex: true\n---\nNot for crawlers.\n");
  await write("src/content/docs/findable.mdx", "---\ntitle: Findable\nnoindex: true\nsearchable: true\n---\nSearch finds this.\n");
  await write("src/content/docs/draft.mdx", "---\ntitle: Draft\ndraft: true\n---\nUnpublished.\n");
  await write("src/content/docs-v1/guide/index.mdx", "---\ntitle: Old guide\n---\nOld guide body.\n");
  await write("src/content/docs-v0/guide/index.mdx", "---\ntitle: Ancient guide\n---\nHidden body.\n");
  await write("src/content/blog/hello.mdx", "---\ntitle: Hello\n---\nFirst post.\n");
  await write("src/pages/[...slug].astro", PAGE("getCollectionStaticPaths(\"docs\")"));
  await write("src/pages/v1/[...slug].astro", PAGE("getCollectionStaticPaths(\"docs-v1\")"));
  await write("src/pages/v0/[...slug].astro", PAGE("getCollectionStaticPaths(\"docs-v0\")"));
  await write("src/pages/blog/[...slug].astro", PAGE("getCollectionStaticPaths(\"blog\")"));
  await write("src/pages/qv/[...slug].astro", API_PAGE);
  await write("src/pages/[...slug]/index.md.ts", `import { markdownRoute } from ${srcModule("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`);
  await write("src/pages/llms.txt.ts", `import { llmsRoute } from ${srcModule("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsRoute();\n`);
  await write("src/pages/[...section]/llms.txt.ts", `import { llmsSectionRoute } from ${srcModule("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`);
  await write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');

  const adapter: AstroIntegration = {
    name: "@astrojs/cloudflare",
    hooks: {
      "astro:config:done": ({ setAdapter }) => {
        setAdapter({
          name: "@astrojs/cloudflare",
          entrypointResolution: "auto",
          serverEntrypoint: path.join(root, "server-entry.mjs"),
          supportedAstroFeatures: { serverOutput: "stable" },
        });
      },
    },
  };
  try {
    await buildIn(root, options, adapter);
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }
  const { app } = (await import(pathToFileURL(path.join(root, ".server/entry.mjs")).href)) as { app: Site["app"] };
  assetRoots.set(options.host, { dir: path.join(root, "dist"), base: options.base ?? "/" });
  return { root, host: options.host, base: options.base ?? "/", app };
}

async function buildIn(root: string, options: { host: string; base?: string; adapter?: boolean }, adapter: AstroIntegration) {
  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
    vite: {
      cacheDir: path.join(root, ".vite"),
      resolve: {
        alias: [
          { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(SRC_DIR, "index.ts") },
          { find: /^@cloudflare\/nimbus-docs\//, replacement: `${SRC_DIR}/` },
        ],
      },
    },
    ...(options.base ? { base: options.base } : {}),
    ...(options.adapter === false ? { output: "static" as const } : { output: "server" as const, adapter }),
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: `https://${options.host}`,
          title: "Test",
          description: "Test",
          search: false,
          versions: { current: "v2", others: ["v1", "v0"], deprecated: ["v1"], hidden: ["v0"] },
          rendering: { default: "build", collections: { qv: "request", blog: "build" } },
          api: [
            {
              collection: "qv",
              versionUrl: { in: "query" },
              versions: [
                { version: "v2", spec: "./specs/v2.json", default: true },
                { version: "v1", spec: "./specs/v1.json" },
              ],
            },
          ],
          agents: { mcp: true },
        } as Parameters<typeof nimbus>[0],
        { admonitions: false, sitemap: true, validateMdx: false },
      ),
    ],
  } as never);
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const cardSchema = JSON.parse(await readFile(new URL("./fixtures/mcp/server-card.schema.json", import.meta.url), "utf8"));
const validateCard = ajv.compile({ ...cardSchema, $ref: "#/$defs/ServerCard" });

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const linksOf = (llms: string) => [...llms.matchAll(/^- \[[^\]]*\]\(([^)]+)\)/gm)].map((m) => m[1]!);

function suite(name: string, options: { host: string; base?: string }) {
  describe(name, () => {
    let site: Site;
    const prefix = options.base ? options.base.replace(/\/$/, "") : "";
    const origin = `https://${options.host}`;
    const endpoint = `${origin}${prefix}/mcp`;
    const call = async (tool: string, args: Record<string, unknown>) => {
      const message = await readRpcResponse(await site.app.render(rpcRequest(endpoint, "tools/call", { name: tool, arguments: args })));
      assert.equal(message.error, undefined, JSON.stringify(message));
      return { isError: (message.result as { isError?: boolean }).isError === true, value: toolText(message) as Record<string, unknown> };
    };
    // The bare test adapter writes under dist/ without the base segments.
    const dist = (pathname: string) => path.join(site.root, "dist", ...pathname.replace(/^\//, "").split("/"));

    before(async () => {
      site = await buildSite(options);
    });
    after(async () => {
      if (process.env.NIMBUS_MCP_KEEP) return;
      await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
    });

    test("initialize answers at the endpoint and at the slashed form, reporting the derived name and package version", async () => {
      for (const url of [endpoint, `${endpoint}/`]) {
        const response = await site.app.render(rpcRequest(url, "initialize", INITIALIZE_PARAMS, 1, { Origin: "https://client.example" }));
        assert.equal(response.status, 200, url);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        const result = (await readRpcResponse(response)).result as { serverInfo: { name: string; version: string }; instructions: string };
        assert.equal(result.serverInfo.name, `${options.host.split(".").reverse().join(".")}/docs`);
        assert.equal(result.serverInfo.version, runningNimbusVersion());
        assert.match(result.instructions, /no search/);
      }
      assert.equal((await site.app.render(new Request(endpoint))).status, 405);
      assert.equal((await site.app.render(rpcRequest(endpoint, "initialize", INITIALIZE_PARAMS, 1, { Origin: "null" }))).status, 403);
    });

    test("list_pages by default is search's set; its current-version subset is the root llms.txt; a version is its section llms.txt", async () => {
      const { value } = await call("list_pages", {});
      const pages = value.pages as Array<{ url: string; markdownUrl: string; version?: string; section: string; description?: string }>;
      assert.deepEqual(
        pages.map((page) => page.url),
        [
          `${origin}${prefix}/`,
          `${origin}${prefix}/blog/hello/`,
          `${origin}${prefix}/findable/`,
          `${origin}${prefix}/guide/`,
          `${origin}${prefix}/guide/advanced/`,
          `${origin}${prefix}/qv/`,
          `${origin}${prefix}/qv/list-pets/`,
        ],
        "noindex, draft, deprecated and hidden pages stay out; a searchable noindex page is in",
      );
      assert.equal(pages[3]!.description, "Start here");
      assert.equal(pages[3]!.version, "v2");
      assert.equal(pages[3]!.section, "guide");
      assert.equal(pages[1]!.section, "blog");
      const root = await readFile(dist("/llms.txt"), "utf8");
      // The root llms.txt lists leaves and section files; the union of the
      // section files' pages and the root's own page links is the current
      // version's discoverable set, which is the default list minus the
      // searchable-but-noindex page and minus other versions.
      const rootPages: string[] = [];
      for (const link of linksOf(root)) {
        if (!link.endsWith("/llms.txt")) {
          rootPages.push(link);
          continue;
        }
        // A section whose pages render on request (the API here) serves its
        // llms.txt on request too; the others are files.
        const sectionPath = dist(new URL(link).pathname.slice(prefix.length));
        const section = existsSync(sectionPath)
          ? await readFile(sectionPath, "utf8")
          : await (await site.app.render(new Request(link))).text();
        rootPages.push(...linksOf(section).filter((item) => !item.endsWith("/llms.txt")));
      }
      const current = pages
        .filter((page) => page.version === undefined || page.version === "v2")
        .filter((page) => page.url !== `${origin}${prefix}/findable/`)
        .map((page) => page.markdownUrl)
        .sort();
      assert.deepEqual([...new Set(rootPages)].sort(), current);
      assert.ok(!root.includes("/v1/") && !root.includes("/v0/") && !root.includes("/internal/"), "root llms.txt has no other versions and no noindex");
      assert.match(root, new RegExp(`^MCP server \\(Streamable HTTP; tools list_pages and get_page over these pages\\): ${escapeRegExp(endpoint)}$`, "m"));
      const v1 = await call("list_pages", { version: "v1" });
      const v1Pages = (v1.value.pages as Array<{ markdownUrl: string }>).map((page) => page.markdownUrl);
      assert.deepEqual(v1Pages, [`${origin}${prefix}/v1/guide/index.md`]);
      assert.deepEqual(linksOf(await readFile(dist("/v1/llms.txt"), "utf8")), v1Pages);
      const v0 = await call("list_pages", { version: "v0" });
      assert.equal(v0.isError, true, "a hidden version is not a version");
      assert.equal(existsSync(dist("/v0/llms.txt")), false);
      const guide = await call("list_pages", { section: "guide" });
      assert.deepEqual((guide.value.pages as Array<{ url: string }>).map((p) => p.url), [`${origin}${prefix}/guide/`, `${origin}${prefix}/guide/advanced/`]);
    });

    test("get_page reads the Markdown twin by URL or path, resolves ?version= to the default, and hides hidden versions", async () => {
      for (const url of [`${origin}${prefix}/guide/`, `${prefix}/guide/`, "/guide/", `${origin}${prefix}/guide/#install`]) {
        const { value, isError } = await call("get_page", { url });
        assert.equal(isError, false, url);
        assert.equal(value.title, "Guide");
        assert.equal(value.url, `${origin}${prefix}/guide/`);
        assert.equal(value.markdownUrl, `${origin}${prefix}/guide/index.md`);
        assert.match(value.content as string, /## Install\n\nRun the installer\./);
        assert.doesNotMatch(value.content as string, /^---/, "the content is the page body, not the twin's header");
      }
      const twin = await readFile(dist("/guide/index.md"), "utf8");
      assert.ok(twin.includes((await call("get_page", { url: "/guide/" })).value.content as string), "get_page content is what the .md route serves");
      const noindex = await call("get_page", { url: "/internal/" });
      assert.equal(noindex.isError, false, "noindex pages resolve, like search");
      const versioned = await call("get_page", { url: `${origin}${prefix}/qv/list-pets/?version=v1` });
      assert.equal(versioned.isError, false);
      assert.equal(versioned.value.url, `${origin}${prefix}/qv/list-pets/`);
      assert.match(versioned.value.content as string, /v2/);
      for (const url of ["/v0/guide/", "/draft/", "/missing/"]) {
        const { isError, value } = await call("get_page", { url });
        assert.equal(isError, true, url);
        assert.equal((value.error as { code: string }).code, "not_found");
      }
    });

    test("the card is written under base, validates, and is listed in discovery with a typed header rule", async () => {
      const cardPath = dist("/mcp/server-card");
      const card = JSON.parse(await readFile(cardPath, "utf8"));
      assert.equal(validateCard(card), true, JSON.stringify(validateCard.errors));
      assert.deepEqual(card.remotes, [{ type: "streamable-http", url: endpoint }]);
      assert.equal(card.version, runningNimbusVersion());
      assert.equal("capabilities" in card, false);
      const catalog = JSON.parse(await readFile(dist(".well-known/ai-catalog.json"), "utf8")) as { entries: Array<{ type: string; url: string }> };
      const entry = catalog.entries.find((item) => item.type === "application/mcp-server-card+json");
      assert.equal(entry?.url, `${endpoint}/server-card`);
      // Under a base the Cloudflare adapter keeps control files at the asset
      // root above the base directory, and so does Nimbus.
      const headers = await readFile(prefix ? path.join(site.root, "_headers") : dist("/_headers"), "utf8");
      assert.match(headers, new RegExp(`^${escapeRegExp(prefix)}\\/mcp\\/server-card\\n  Content-Type: application\\/mcp-server-card\\+json\\n  Access-Control-Allow-Origin: \\*\\n  Access-Control-Allow-Methods: GET\\n  Access-Control-Expose-Headers: ETag$`, "m"));
    });
  });
}

suite("at the site root", { host: "root.test" });
suite("under base /docs", { host: "based.test", base: "/docs" });

test("a static build with agents.mcp is an author error that names the adapter flip", async () => {
  await assert.rejects(
    () => buildSite({ host: "static.test", adapter: false }),
    /rendering mode "request" needs a server adapter[\s\S]*add adapter-cloudflare/,
  );
});
