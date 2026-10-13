// The remote MCP server, driven with raw Requests and no client: the
// HTTP surface (methods, CORS, Origin, body cap), the handshake, the two
// tools, their visibility rules, pagination and URL resolution.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_LIST_PAGE_SIZE,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_PAGE_CONTENT_LIMIT,
  createDocsMcpHandler,
  originIsWellFormed,
  resolvePageRecord,
} from "../src/_internal/mcp/handler.js";
import { mcpServerIdentity } from "../src/_internal/mcp/identity.js";
import type { McpPageIndex, McpPageRecord } from "../src/_internal/mcp/page-index.js";
import { INITIALIZE_PARAMS, readRpcResponse, rpcRequest, toolText } from "./fixtures/mcp/rpc.js";

const SITE = "https://docs.example.com";

function record(
  path: string,
  overrides: Partial<McpPageRecord> & { base?: string } = {},
): McpPageRecord {
  const { base = "/", ...rest } = overrides;
  const prefix = base === "/" ? "" : base.replace(/\/$/, "");
  const markdownPath = path === "/" ? "/index.md" : `${path.replace(/\/$/, "")}/index.md`;
  const title = path === "/" ? "Home" : path.split("/").filter(Boolean).join(" ");
  return {
    title,
    url: `${SITE}${prefix}${path}`,
    markdownUrl: `${SITE}${prefix}${markdownPath}`,
    path,
    markdownPath,
    collection: "docs",
    section: path.split("/").filter(Boolean)[0] ?? "index",
    discoverable: true,
    searchable: true,
    ...rest,
  };
}

const INDEX: McpPageIndex = {
  version: 1,
  currentVersion: "v2",
  versions: ["v2", "v1"],
  pages: [
    record("/", { version: "v2" }),
    record("/guide/", { version: "v2", description: "Start here" }),
    record("/guide/install/", { version: "v2" }),
    record("/internal/", { version: "v2", discoverable: false, searchable: false }),
    record("/findable/", { version: "v2", discoverable: false, searchable: true }),
    record("/v1/guide/", { version: "v1", deprecated: true, collection: "docs-v1", section: "v1" }),
    record("/blog/hello/", { collection: "blog", section: "blog" }),
    record("/api/pets/", { collection: "api", section: "api" }),
  ],
};

function handlerFor(index: McpPageIndex, base = "/", pages: Record<string, string> = {}) {
  return createDocsMcpHandler({
    identity: mcpServerIdentity({ site: SITE, base, title: "Example", version: "0.19.0" }),
    base,
    source: {
      readIndex: async () => index,
      readPage: async (page) => pages[page.path] ?? `# ${page.title}\n\nBody of ${page.path}.\n`,
    },
  });
}

const URL_ = `${SITE}/mcp`;

test("oversized streamed and declared bodies are drained before returning 413", async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    let read = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (read === 3) { controller.close(); return; }
        read++;
        controller.enqueue(new Uint8Array(MCP_MAX_REQUEST_BODY_BYTES / 2));
      },
      cancel() { cancelled = true; },
    });
    const request = new Request(URL_, {
      method: "POST", body, duplex: "half",
      headers: { "Content-Type": "application/json", ...(declared ? { "Content-Length": String(MCP_MAX_REQUEST_BODY_BYTES + 1) } : {}) },
    } as RequestInit);
    const handler = handlerFor(INDEX);
    const response = await handler.fetch(request);
    assert.equal(response.status, 413);
    assert.equal(read, 3, declared ? "Content-Length limit" : "stream limit");
    assert.equal(cancelled, false);
    assert.equal(request.bodyUsed, true);
    assert.equal(request.body?.locked, false);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const next = await handler.fetch(rpcRequest(URL_, "initialize", INITIALIZE_PARAMS));
    assert.equal(next.status, 200);
  }
});

test("OPTIONS is answered with CORS; GET and DELETE are 405 with Allow; a bad Origin is 403", async () => {
  const handler = handlerFor(INDEX);
  const preflight = await handler.fetch(new Request(URL_, { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Mcp-Protocol-Version/);
  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await handler.fetch(new Request(URL_, { method }));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
  for (const origin of ["null", "example.com", "https://a b", "https://docs.example.com/path"]) {
    const response = await handler.fetch(rpcRequest(URL_, "initialize", INITIALIZE_PARAMS, 1, { Origin: origin }));
    assert.equal(response.status, 403, origin);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_origin");
  }
  assert.equal(originIsWellFormed("https://app.example.com:8443"), true);
  assert.equal(originIsWellFormed("chrome-extension://abcdefghijklmnop"), true);
  assert.equal(originIsWellFormed("https://Example.com"), true, "non-canonical case is still an origin");
  assert.equal(originIsWellFormed("http://example.com:80"), true, "a default port is still an origin");
  assert.equal(originIsWellFormed("https://example.com/app"), false, "a path is not an origin");
  assert.equal(originIsWellFormed("https://example.com/?q"), false, "a query is not an origin");
  assert.equal(originIsWellFormed(null), true);
});

test("every tool call reads the index and the page with the request being served", async () => {
  const seen: string[] = [];
  const handler = createDocsMcpHandler({
    identity: mcpServerIdentity({ site: SITE, base: "/", title: "Example", version: "0.19.0" }),
    base: "/",
    source: {
      readIndex: async (request) => {
        seen.push(new URL(request.url).hostname);
        return INDEX;
      },
      readPage: async (page, request) => {
        seen.push(`page@${new URL(request.url).hostname}`);
        return `# ${page.title}`;
      },
    },
  });
  for (const host of ["first.test", "second.test"]) {
    const request = rpcRequest(`https://${host}/mcp`, "tools/call", { name: "get_page", arguments: { url: "/guide/" } });
    await readRpcResponse(await handler.fetch(request));
  }
  assert.deepEqual(seen, ["first.test", "page@first.test", "second.test", "page@second.test"]);
});

test("a page store that cannot be read is a structured not_found, not a raw error", async () => {
  const handler = createDocsMcpHandler({
    identity: mcpServerIdentity({ site: SITE, base: "/", title: "Example", version: "0.19.0" }),
    base: "/",
    source: {
      readIndex: async () => INDEX,
      readPage: async () => {
        throw new Error("nimbus-docs: build output file x returned 404. Check the site's client files (dist/client) were deployed with the server.");
      },
    },
  });
  const { value, isError } = await call(handler, "get_page", { url: "/guide/" });
  assert.equal(isError, true);
  assert.equal((value.error as { code: string }).code, "not_found");
  assert.doesNotMatch((value.error as { message: string }).message, /dist\/client|returned 404/);
});

test("initialize reports the derived name, the package version, instructions and the tools capability", async () => {
  const handler = handlerFor(INDEX);
  const response = await handler.fetch(
    rpcRequest(URL_, "initialize", INITIALIZE_PARAMS, 1, { Origin: "https://app.example.com" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-expose-headers") ?? "", /Mcp-Protocol-Version/);
  const message = await readRpcResponse(response);
  const result = message.result as {
    serverInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
    instructions: string;
    protocolVersion: string;
  };
  assert.deepEqual(result.serverInfo, {
    name: "com.example.docs/docs",
    version: "0.19.0",
    title: "Example",
    websiteUrl: "https://docs.example.com/",
    description: "Read the Example documentation: get_page and list_pages, no search.",
  });
  assert.ok("tools" in result.capabilities);
  assert.match(result.instructions, /two tools and no search/);
});

test("tools/list returns get_page and list_pages with strict input schemas and read-only annotations", async () => {
  const handler = handlerFor(INDEX);
  const message = await readRpcResponse(await handler.fetch(rpcRequest(URL_, "tools/list")));
  const tools = (message.result as { tools: Array<Record<string, unknown>> }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["get_page", "list_pages"],
  );
  for (const tool of tools) {
    const schema = tool.inputSchema as { additionalProperties?: boolean; properties: Record<string, unknown> };
    assert.equal(schema.additionalProperties, false);
    assert.equal((tool.annotations as { readOnlyHint?: boolean }).readOnlyHint, true);
  }
  assert.deepEqual(Object.keys((tools[0]!.inputSchema as { properties: object }).properties), ["url"]);
  assert.deepEqual(Object.keys((tools[1]!.inputSchema as { properties: object }).properties), ["section", "version", "cursor"]);
});

async function call(handler: ReturnType<typeof handlerFor>, name: string, args: Record<string, unknown>) {
  const message = await readRpcResponse(await handler.fetch(rpcRequest(URL_, "tools/call", { name, arguments: args })));
  if (message.error) return { rpcError: message.error };
  return { isError: (message.result as { isError?: boolean }).isError === true, value: toolText(message) as Record<string, unknown> };
}

test("list_pages by default matches search: noindex out unless searchable, deprecated out, other collections in", async () => {
  const handler = handlerFor(INDEX);
  const { value, isError } = await call(handler, "list_pages", {});
  assert.equal(isError, false);
  const pages = value.pages as Array<{ url: string; section: string; version?: string; description?: string }>;
  assert.deepEqual(
    pages.map((page) => page.url),
    [
      `${SITE}/`,
      `${SITE}/guide/`,
      `${SITE}/guide/install/`,
      `${SITE}/findable/`,
      `${SITE}/blog/hello/`,
      `${SITE}/api/pets/`,
    ],
  );
  assert.equal(pages[1]!.description, "Start here");
  assert.equal(pages[1]!.section, "guide");
  assert.equal(pages[1]!.version, "v2");
  assert.equal("nextCursor" in value, false);
});

test("list_pages filters by section and by an explicit version, which allows a deprecated one", async () => {
  const handler = handlerFor(INDEX);
  const guide = await call(handler, "list_pages", { section: "guide" });
  assert.deepEqual((guide.value.pages as Array<{ url: string }>).map((p) => p.url), [`${SITE}/guide/`, `${SITE}/guide/install/`]);
  const v1 = await call(handler, "list_pages", { version: "v1" });
  assert.deepEqual((v1.value.pages as Array<{ url: string }>).map((p) => p.url), [`${SITE}/v1/guide/`]);
  const none = await call(handler, "list_pages", { section: "nope" });
  assert.deepEqual(none.value.pages, []);
  const unknown = await call(handler, "list_pages", { version: "v9" });
  assert.equal(unknown.isError, true);
  assert.deepEqual((unknown.value.error as { code: string }).code, "invalid_input");
  assert.match((unknown.value.error as { message: string }).message, /Versions: v2, v1/);
});

test("list_pages pages 200 at a time through an opaque cursor and rejects a cursor from other filters", async () => {
  const many: McpPageIndex = {
    version: 1,
    versions: [],
    pages: Array.from({ length: MCP_LIST_PAGE_SIZE + 50 }, (_, i) =>
      record(`/p/${String(i).padStart(3, "0")}/`),
    ),
  };
  const handler = handlerFor(many);
  const first = await call(handler, "list_pages", {});
  assert.equal((first.value.pages as unknown[]).length, MCP_LIST_PAGE_SIZE);
  const cursor = first.value.nextCursor as string;
  assert.equal(typeof cursor, "string");
  assert.doesNotMatch(cursor, /[=+/]/);
  const second = await call(handler, "list_pages", { cursor });
  assert.equal((second.value.pages as unknown[]).length, 50);
  assert.equal("nextCursor" in second.value, false);
  assert.equal((second.value.pages as Array<{ url: string }>)[0]!.url, `${SITE}/p/200/`);
  const mismatched = await call(handler, "list_pages", { cursor, section: "p" });
  assert.equal(mismatched.isError, true);
  assert.equal((mismatched.value.error as { code: string }).code, "invalid_input");
  const garbage = await call(handler, "list_pages", { cursor: "not-a-cursor" });
  assert.equal(garbage.isError, true);
});

test("get_page accepts an absolute URL, a site path, a .md path, a query and a fragment, and reports not_found", async () => {
  const handler = handlerFor(INDEX);
  for (const url of [
    `${SITE}/guide/`,
    `${SITE}/guide`,
    "/guide/",
    "/guide",
    "guide",
    "/guide/index.md",
    `${SITE}/guide/#install`,
    `${SITE}/guide/?version=v1`,
    "https://preview.example.workers.dev/guide/",
  ]) {
    const { value, isError } = await call(handler, "get_page", { url });
    assert.equal(isError, false, url);
    assert.deepEqual(
      { title: value.title, url: value.url, markdownUrl: value.markdownUrl },
      { title: "guide", url: `${SITE}/guide/`, markdownUrl: `${SITE}/guide/index.md` },
      url,
    );
    assert.equal(value.content, "# guide\n\nBody of /guide/.\n");
    assert.equal("truncated" in value, false);
  }
  const home = await call(handler, "get_page", { url: "/" });
  assert.equal(home.value.title, "Home");
  const hidden = await call(handler, "get_page", { url: "/internal/" });
  assert.equal(hidden.isError, false, "noindex pages resolve, like search");
  for (const url of ["/missing/", `${SITE}/v0/guide/`, "/guide/index.mdx"]) {
    const { value, isError } = await call(handler, "get_page", { url });
    assert.equal(isError, true, url);
    assert.equal((value.error as { code: string }).code, "not_found");
  }
});

test("get_page strips a configured base from URLs and paths", () => {
  const base = "/docs/";
  const index: McpPageIndex = { version: 1, versions: [], pages: [record("/guide/", { base })] };
  for (const url of [`${SITE}/docs/guide/`, "/docs/guide/", "/guide/", "/docs/guide/index.md"]) {
    assert.equal(resolvePageRecord(url, index, base)?.path, "/guide/", url);
  }
});

test("get_page cuts long pages near the limit and says so", async () => {
  const long = "é".repeat(MCP_PAGE_CONTENT_LIMIT + 10);
  const handler = handlerFor(INDEX, "/", { "/guide/": long });
  const { value } = await call(handler, "get_page", { url: "/guide/" });
  assert.equal(value.truncated, true);
  assert.equal([...(value.content as string)].length, MCP_PAGE_CONTENT_LIMIT);
});

test("schema-invalid arguments are the structured invalid_input error, and a body over 64 KB is 413", async () => {
  const handler = handlerFor(INDEX);
  for (const [name, args, detail] of [
    ["get_page", { url: "/guide/", extra: true }, /extra/],
    ["get_page", {}, /url/],
    ["get_page", { url: 5 }, /url/],
    ["list_pages", { version: "" }, /version/],
    ["list_pages", { limit: 5 }, /limit/],
  ] as const) {
    const { value, isError, rpcError } = await call(handler, name, args);
    assert.equal(rpcError, undefined);
    assert.equal(isError, true, JSON.stringify(args));
    assert.equal((value.error as { code: string }).code, "invalid_input");
    assert.match((value.error as { message: string }).message, detail);
  }
  const big = new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MCP_MAX_REQUEST_BODY_BYTES) } }),
  });
  assert.equal((await handler.fetch(big)).status, 413);
});
