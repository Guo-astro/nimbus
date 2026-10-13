/**
 * The remote MCP server behind `/mcp`: the web-standard SDK's stateless
 * handler with two read tools over the page index and the Markdown twins.
 * One module wraps the SDK so a swap stays away from the route and tests.
 */
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  type McpHttpHandler,
  type StandardSchemaWithJSON,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { McpServerIdentity } from "./identity.js";
import type { McpPageIndex, McpPageRecord } from "./page-index.js";
import { stripBase, toRouteKey } from "../url.js";

/** Bodies over this are answered `413` before anything is parsed. */
export const MCP_MAX_REQUEST_BODY_BYTES = 64 * 1024;
/** `list_pages` returns this many pages per call. */
export const MCP_LIST_PAGE_SIZE = 200;
/** `get_page` content is cut near this many code points, with `truncated: true`. */
export const MCP_PAGE_CONTENT_LIMIT = 100_000;

export type McpToolErrorCode = "invalid_input" | "not_found";
export interface McpToolError {
  error: { code: McpToolErrorCode; message: string };
}

export interface GetPageResult {
  title: string;
  url: string;
  markdownUrl: string;
  content: string;
  truncated?: true;
}

export interface ListPagesResult {
  pages: Array<{
    title: string;
    url: string;
    markdownUrl: string;
    description?: string;
    section: string;
    version?: string;
  }>;
  nextCursor?: string;
}

/** What the route gives the handler: the baked index and each page's Markdown. */
export interface DocsMcpSource {
  readIndex(request: Request): Promise<McpPageIndex>;
  /** The page's clean Markdown, or `null` when its twin is missing. */
  readPage(record: McpPageRecord, request: Request): Promise<string | null>;
}

export interface DocsMcpHandlerOptions {
  identity: McpServerIdentity;
  /** The site's Astro `base`, so `/docs/guide/` resolves like `/guide/`. */
  base: string;
  source: DocsMcpSource;
}

export interface DocsMcpHandler {
  fetch(request: Request): Promise<Response>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
} as const;

export const GET_PAGE_TOOL = {
  name: "get_page",
  title: "Get a documentation page",
  description:
    "Return one documentation page as Markdown. Pass the page's URL as list_pages returns it (an absolute URL), " +
    "or a site-relative path such as /guide/. Long pages are cut near 100,000 characters with truncated: true; " +
    "the markdownUrl serves the whole page.",
  inputSchema: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2048 },
    },
  },
} as const;

export const LIST_PAGES_TOOL = {
  name: "list_pages",
  title: "List documentation pages",
  description:
    "List published documentation pages: title, URL, Markdown URL, description, section and version. " +
    "By default the list matches site search: pages marked noindex and deprecated versions are left out. " +
    "Filter by section (a top-level path segment) or by one version; pass nextCursor back as cursor for the next 200.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      section: { type: "string", minLength: 1, maxLength: 200 },
      version: { type: "string", minLength: 1, maxLength: 100 },
      cursor: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
} as const;

export function toolError(code: McpToolErrorCode, message: string): McpToolError {
  return { error: { code, message } };
}

/**
 * The page a `get_page` URL names: an absolute URL or a site path, with
 * the base, a query (`?version=` on an API URL resolves the default) and a
 * fragment dropped; a `.md` path is accepted as is.
 */
export function resolvePageRecord(
  url: string,
  index: McpPageIndex,
  base: string,
): McpPageRecord | undefined {
  let pathname: string;
  try {
    pathname = /^https?:\/\//i.test(url)
      ? new URL(url).pathname
      : new URL(url, "https://nimbus.invalid/").pathname;
  } catch {
    return undefined;
  }
  if (!url.startsWith("/") && !/^https?:\/\//i.test(url)) {
    pathname = `/${url.split(/[?#]/)[0]}`;
  }
  const sitePath = stripBase(pathname, base);
  const markdownPath = /\.md$/i.test(sitePath)
    ? toRouteKey(sitePath)
    : (() => {
        const route = toRouteKey(sitePath);
        return route === "/" ? "/index.md" : `${route}/index.md`;
      })();
  return index.pages.find((page) => page.markdownPath === markdownPath);
}

function listFilter(
  index: McpPageIndex,
  input: { section?: string; version?: string },
): McpPageRecord[] {
  return index.pages.filter(
    (page) =>
      page.searchable &&
      (input.version === undefined ? !page.deprecated : page.version === input.version) &&
      (input.section === undefined || page.section === input.section),
  );
}

function encodeCursor(offset: number, key: string): string {
  const bytes = new TextEncoder().encode(`${offset}:${key}`);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(cursor: string, key: string): number | undefined {
  let decoded: string;
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    decoded = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1 || decoded.slice(separator + 1) !== key) return undefined;
  const offset = Number(decoded.slice(0, separator));
  return Number.isInteger(offset) && offset >= 0 ? offset : undefined;
}

export function listPages(
  input: { section?: string; version?: string; cursor?: string },
  index: McpPageIndex,
): ListPagesResult | McpToolError {
  if (input.version !== undefined && !index.versions.includes(input.version)) {
    return toolError(
      "invalid_input",
      index.versions.length
        ? `Unknown version "${input.version}". Versions: ${index.versions.join(", ")}.`
        : "This site has no versions; call list_pages without a version.",
    );
  }
  const matches = listFilter(index, input);
  const key = `${input.section ?? ""}\u0000${input.version ?? ""}`;
  const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor, key);
  if (offset === undefined) {
    return toolError(
      "invalid_input",
      "The cursor is not one list_pages returned for these filters. Start again without a cursor.",
    );
  }
  const slice = matches.slice(offset, offset + MCP_LIST_PAGE_SIZE);
  return {
    pages: slice.map((page) => ({
      title: page.title,
      url: page.url,
      markdownUrl: page.markdownUrl,
      ...(page.description ? { description: page.description } : {}),
      section: page.section,
      ...(page.version ? { version: page.version } : {}),
    })),
    ...(offset + MCP_LIST_PAGE_SIZE < matches.length
      ? { nextCursor: encodeCursor(offset + MCP_LIST_PAGE_SIZE, key) }
      : {}),
  };
}

export function pageResult(record: McpPageRecord, content: string): GetPageResult {
  const result = { title: record.title, url: record.url, markdownUrl: record.markdownUrl };
  // UTF-16 length bounds the code-point count, so short pages skip the spread.
  if (content.length <= MCP_PAGE_CONTENT_LIMIT) return { ...result, content };
  const points = [...content];
  if (points.length <= MCP_PAGE_CONTENT_LIMIT) return { ...result, content };
  return { ...result, content: points.slice(0, MCP_PAGE_CONTENT_LIMIT).join(""), truncated: true };
}

/**
 * A present `Origin` must be an origin: a scheme and a host, nothing after.
 * The opaque `null` origin is refused. Extension schemes (`chrome-extension://id`)
 * have a `null` tuple origin in the URL parser, so they're checked by shape.
 */
export function originIsWellFormed(origin: string | null): boolean {
  if (origin === null) return true;
  if (origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Non-special schemes (extensions) parse with an empty path.
  if (parsed.host === "" || !["/", ""].includes(parsed.pathname) || parsed.search || parsed.hash) return false;
  if (parsed.origin !== "null") return true;
  return `${parsed.protocol}//${parsed.host}`.toLowerCase() === origin.toLowerCase();
}

/**
 * The tool's input schema for `tools/list`, with the SDK's own check
 * disabled: the tool validates in its callback, so a mismatch comes back
 * as the structured `invalid_input` error every other failure uses.
 */
function describedSchema<T>(
  schema: Record<string, unknown>,
  validator: jsonSchemaValidator,
): StandardSchemaWithJSON<T, T> {
  const described = fromJsonSchema<T>(schema, validator);
  return {
    "~standard": {
      ...described["~standard"],
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

function invalidArguments(
  validator: jsonSchemaValidator,
  schema: Record<string, unknown>,
): (args: unknown) => McpToolError | undefined {
  const check = validator.getValidator(schema);
  return (args) => {
    const result = check(args);
    return result.valid
      ? undefined
      : toolError("invalid_input", result.errorMessage.replace(/^#:?\s*/u, ""));
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function boundedBody(
  request: Request,
): Promise<Uint8Array<ArrayBuffer> | null> {
  let tooLarge =
    Number(request.headers.get("content-length")) > MCP_MAX_REQUEST_BODY_BYTES;
  if (!request.body) return tooLarge ? null : new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MCP_MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      }
      if (!tooLarge) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (tooLarge) return null;
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createDocsMcpHandler(options: DocsMcpHandlerOptions): DocsMcpHandler {
  const { identity, base, source } = options;
  const validator = new CfWorkerJsonSchemaValidator();
  const checkGetPage = invalidArguments(validator, GET_PAGE_TOOL.inputSchema);
  const checkListPages = invalidArguments(validator, LIST_PAGES_TOOL.inputSchema);
  const getPageSchema = describedSchema<{ url: string }>(GET_PAGE_TOOL.inputSchema, validator);
  const listPagesSchema = describedSchema<{ section?: string; version?: string; cursor?: string }>(
    LIST_PAGES_TOOL.inputSchema,
    validator,
  );
  // The SDK hands the served request to the factory; the fallback is the
  // request `fetch` is serving, for a runtime that leaves it out.
  let serving: Request | undefined;
  const unavailable = (error: unknown) => {
    console.error(error);
    return toolResult(
      toolError("not_found", "The page data could not be read; the site's published files may not be deployed. Try again later."),
      true,
    );
  };
  let sdk: McpHttpHandler | undefined;
  const handler = (): McpHttpHandler => {
    sdk ??= createMcpHandler(
      ({ requestInfo }) => {
        const request = requestInfo ?? serving ?? new Request("https://nimbus.invalid/mcp");
        const server = new McpServer(
          {
            name: identity.name,
            version: identity.version,
            title: identity.title,
            websiteUrl: identity.websiteUrl,
            description: identity.description,
          },
          { instructions: identity.instructions, jsonSchemaValidator: validator },
        );
        server.registerTool(
          GET_PAGE_TOOL.name,
          {
            title: GET_PAGE_TOOL.title,
            description: GET_PAGE_TOOL.description,
            inputSchema: getPageSchema,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          },
          async (args) => {
            const invalid = checkGetPage(args);
            if (invalid) return toolResult(invalid, true);
            let index: McpPageIndex;
            try {
              index = await source.readIndex(request);
            } catch (error) {
              return unavailable(error);
            }
            const record = resolvePageRecord(args.url, index, base);
            if (!record) {
              return toolResult(
                toolError("not_found", `No published page at ${args.url}. list_pages names every page.`),
                true,
              );
            }
            let content: string | null;
            try {
              content = await source.readPage(record, request);
            } catch (error) {
              return unavailable(error);
            }
            if (content === null) {
              return toolResult(
                toolError("not_found", `No Markdown for ${record.url}; read ${record.markdownUrl} directly.`),
                true,
              );
            }
            return toolResult(pageResult(record, content));
          },
        );
        server.registerTool(
          LIST_PAGES_TOOL.name,
          {
            title: LIST_PAGES_TOOL.title,
            description: LIST_PAGES_TOOL.description,
            inputSchema: listPagesSchema,
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          },
          async (args) => {
            const invalid = checkListPages(args);
            if (invalid) return toolResult(invalid, true);
            let index: McpPageIndex;
            try {
              index = await source.readIndex(request);
            } catch (error) {
              return unavailable(error);
            }
            const result = listPages(args, index);
            return toolResult(result, "error" in result);
          },
        );
        return server;
      },
      { legacy: "stateless", maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES },
    );
    return sdk;
  };
  return {
    async fetch(request) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method !== "POST") {
        return json(
          { error: { code: "method_not_allowed", message: "POST a JSON-RPC message; this server is stateless." } },
          405,
          { Allow: "POST, OPTIONS" },
        );
      }
      if (!originIsWellFormed(request.headers.get("origin"))) {
        return json({ error: { code: "invalid_origin", message: "The Origin header is not a valid origin." } }, 403);
      }
      serving = request;
      // Bound and consume the network stream before the SDK clones it. Its
      // stateless handler otherwise leaves a tee branch unread on a 413.
      // Drain oversized bodies without retaining them: cancelling alone
      // leaves local Workers keep-alive connections unable to serve the next POST.
      const body = await boundedBody(request);
      if (body === null) return json({
        jsonrpc: "2.0", id: null,
        error: { code: -32000, message: `Request body exceeds ${MCP_MAX_REQUEST_BODY_BYTES} bytes.` },
      }, 413);
      const response = await handler().fetch(new Request(request, { body }));
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}
