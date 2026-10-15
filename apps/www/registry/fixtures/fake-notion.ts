// A local stand-in for Notion's API, answering in its recorded response
// shapes, for the tests of the loader the Notion guide writes. The loader
// reaches it through the client's `fetch` option, so `@notionhq/client`'s own
// pagination and retry code runs. Lists page two items at a time, so every
// list paginates.

import http from "node:http";

export interface FakeBlock {
  type: string;
  /** Rich text, as segments; a segment may carry an href or annotations. */
  text?: Array<string | { text: string; href?: string; bold?: boolean; code?: boolean }>;
  children?: FakeBlock[];
  language?: string;
  url?: string;
  checked?: boolean;
  rows?: string[][];
}

export interface FakePage {
  id: string;
  title: string;
  slug?: string;
  description?: string;
  order?: number;
  status?: string | boolean;
  blocks: FakeBlock[];
}

export type PropertyTypes = Record<string, string>;

export interface FakeData {
  databaseId: string;
  dataSources: Array<{ id: string; name: string; properties?: PropertyTypes }>;
  pages: FakePage[];
}

export const DEFAULT_PROPERTIES: PropertyTypes = {
  Name: "title",
  Description: "rich_text",
  Slug: "rich_text",
  Order: "number",
  Status: "status",
};

interface Failure {
  method: string;
  path: RegExp;
  status: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
  times: number;
}

const rich = (segments: FakeBlock["text"] = []) =>
  segments.map((segment) => {
    const s = typeof segment === "string" ? { text: segment } : segment;
    return {
      type: "text",
      text: { content: s.text, link: s.href ? { url: s.href } : null },
      annotations: { bold: !!s.bold, italic: false, strikethrough: false, underline: false, code: !!s.code, color: "default" },
      plain_text: s.text,
      href: s.href ?? null,
    };
  });

let blockCounter = 0;

function blockJson(block: FakeBlock, id: string) {
  const base = { object: "block", id, type: block.type, has_children: !!block.children?.length, archived: false, in_trash: false };
  switch (block.type) {
    case "code":
      return { ...base, code: { rich_text: rich(block.text), language: block.language ?? "plain text", caption: [] } };
    case "image":
      return { ...base, image: { type: "external", external: { url: block.url }, caption: rich(block.text) } };
    case "divider":
      return { ...base, divider: {} };
    case "to_do":
      return { ...base, to_do: { rich_text: rich(block.text), checked: !!block.checked, color: "default" } };
    case "table":
      return { ...base, has_children: true, table: { table_width: block.rows?.[0]?.length ?? 0, has_column_header: true, has_row_header: false } };
    case "table_row":
      return { ...base, table_row: { cells: (block.rows?.[0] ?? []).map((cell) => rich([cell])) } };
    case "bookmark":
      return { ...base, bookmark: { url: block.url, caption: [] } };
    default:
      return { ...base, [block.type]: { rich_text: rich(block.text), color: "default" } };
  }
}

function pageJson(page: FakePage, properties: PropertyTypes, index: number) {
  const props: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(properties)) {
    const value =
      type === "title"
        ? { title: rich([page.title]) }
        : name === "Slug" && type === "rich_text"
          ? { rich_text: page.slug ? rich([page.slug]) : [] }
          : name === "Description" && type === "rich_text"
            ? { rich_text: page.description ? rich([page.description]) : [] }
            : type === "number"
              ? { number: page.order ?? null }
              : type === "status"
                ? { status: typeof page.status === "string" ? { id: "s", name: page.status, color: "default" } : null }
                : type === "select"
                  ? { select: typeof page.status === "string" ? { id: "s", name: page.status, color: "default" } : null }
                  : type === "checkbox"
                    ? { checkbox: page.status === true }
                    : type === "rich_text"
                      ? { rich_text: [] }
                      : {};
    props[name] = { id: name.slice(0, 4), type, ...value };
  }
  return {
    object: "page",
    id: page.id,
    url: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
    created_time: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    last_edited_time: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    archived: false,
    in_trash: false,
    properties: props,
    parent: { type: "data_source_id", data_source_id: "ds" },
  };
}

export interface FakeNotion {
  origin: string;
  /** `METHOD path` of every request, in order. */
  requests: string[];
  set(data: FakeData): void;
  fail(rule: Omit<Failure, "times" | "body"> & { times?: number; body?: Record<string, unknown> }): void;
  close(): Promise<void>;
}

export async function fakeNotion(initial: FakeData): Promise<FakeNotion> {
  let data = initial;
  let blocks = new Map<string, Array<ReturnType<typeof blockJson>>>();
  const failures: Failure[] = [];
  const requests: string[] = [];

  const index = () => {
    blocks = new Map();
    const add = (parent: string, list: FakeBlock[]) => {
      const out = list.map((block) => {
        const id = `block-${++blockCounter}`;
        if (block.type === "table") {
          blocks.set(id, (block.rows ?? []).map((row) => blockJson({ type: "table_row", rows: [row] }, `block-${++blockCounter}`)));
        } else if (block.children?.length) {
          add(id, block.children);
        }
        return blockJson(block, id);
      });
      blocks.set(parent, out);
    };
    for (const page of data.pages) add(page.id, page.blocks);
  };
  index();

  const list = (items: unknown[], cursor: string | null) => {
    const start = cursor ? Number(cursor) : 0;
    const next = start + 2 < items.length ? String(start + 2) : null;
    return { object: "list", results: items.slice(start, start + 2), next_cursor: next, has_more: next !== null, type: "page_or_data_source" };
  };

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://x");
      const route = `${request.method} ${url.pathname}`;
      requests.push(route);
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(payload));
      };
      const failure = failures.find((f) => f.method === request.method && f.path.test(url.pathname) && f.times > 0);
      if (failure) {
        failure.times -= 1;
        send(failure.status, failure.body, failure.headers);
        return;
      }
      let match: RegExpMatchArray | null;
      if ((match = url.pathname.match(/^\/v1\/databases\/([^/]+)$/)) && request.method === "GET") {
        if (match[1] !== data.databaseId) return send(404, { object: "error", status: 404, code: "object_not_found", message: "not found" });
        return send(200, { object: "database", id: data.databaseId, data_sources: data.dataSources.map(({ id, name }) => ({ id, name })) });
      }
      if ((match = url.pathname.match(/^\/v1\/data_sources\/([^/]+)$/)) && request.method === "GET") {
        const source = data.dataSources.find((s) => s.id === match![1]);
        if (!source) return send(404, { object: "error", status: 404, code: "object_not_found", message: "not found" });
        const properties = Object.fromEntries(
          Object.entries(source.properties ?? DEFAULT_PROPERTIES).map(([name, type]) => [name, { id: name.slice(0, 4), name, type }]),
        );
        return send(200, { object: "data_source", id: source.id, parent: { type: "database_id", database_id: data.databaseId }, properties });
      }
      if ((match = url.pathname.match(/^\/v1\/data_sources\/([^/]+)\/query$/)) && request.method === "POST") {
        const source = data.dataSources.find((s) => s.id === match![1]);
        const properties = source?.properties ?? DEFAULT_PROPERTIES;
        const args = body ? (JSON.parse(body) as { start_cursor?: string }) : {};
        return send(200, list(data.pages.map((page, i) => pageJson(page, properties, i)), args.start_cursor ?? null));
      }
      if ((match = url.pathname.match(/^\/v1\/blocks\/([^/]+)\/children$/)) && request.method === "GET") {
        return send(200, { ...list(blocks.get(match[1]!) ?? [], url.searchParams.get("start_cursor")), type: "block" });
      }
      send(400, { object: "error", status: 400, code: "invalid_request_url", message: `unknown route ${route}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    requests,
    set(next) {
      data = next;
      index();
    },
    fail(rule) {
      failures.push({ times: 1, body: { object: "error", status: rule.status, code: "internal_server_error", message: "failure" }, ...rule });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
