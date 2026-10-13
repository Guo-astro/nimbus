/**
 * A Notion database as a Nimbus page collection. Installed by
 * `nimbus-docs add source notion`; this file is yours to edit.
 *
 *   handbook: defineCollection({
 *     loader: withNimbusMarkdown(notionLoader({ database: "<database id>" })),
 *     schema: docsCollection().schema,
 *   }),
 *
 * Pages are Markdown: they get routes, the sidebar, Markdown twins,
 * `llms.txt`, search, API citations, links and URL collision checks. They
 * don't get MDX components, callouts, an edit link, a git date, filesystem
 * lint or MDX component validation.
 *
 * Each load is a full sync that writes nothing until it has every row and
 * block, so a failed request leaves a dev server on its last good content
 * and fails a build. Written from Notion's API (version 2025-09-03, the
 * `@notionhq/client` v5 default).
 */

import {
  APIResponseError,
  Client,
  isFullBlock,
  isFullPage,
  iterateAllDataSourceRows,
  iteratePaginatedAPI,
} from "@notionhq/client";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client";
import type { Loader } from "astro/loaders";

export interface NotionLoaderOptions {
  /** The database to read. Its data source is used when it has exactly one. */
  database?: string;
  /** A data source to read directly (skips discovery). */
  dataSource?: string;
  /** Default: the `NOTION_TOKEN` environment variable. */
  token?: string;
  /** Property names, when they differ from the defaults. */
  properties?: {
    /** Rich text. Default `"Description"`. */
    description?: string;
    /** Rich text: the entry's URL id. Default `"Slug"`. */
    slug?: string;
    /** Number: `sidebar.order`. Default `"Order"`. */
    order?: string;
    /** Status, select or checkbox: whether a row is published. Default `"Status"`. */
    status?: string;
  };
  /** The status or select value that publishes a row. Default `"Published"`. */
  publishedValue?: string;
  /** Parallel requests. Default 3. */
  concurrency?: number;
  /** The `fetch` the client uses (tests, proxies). */
  fetch?: typeof fetch;
}

type Property = { id: string; name: string; type: string };
type Logger = { info: (message: string) => void; warn: (message: string) => void };

const DEFAULT_PROPERTIES = { description: "Description", slug: "Slug", order: "Order", status: "Status" };

function fail(message: string): never {
  throw new Error(`notionLoader: ${message}`);
}

function listProperties(properties: Record<string, Property>): string {
  const entries = Object.values(properties).map((p) => `${p.name} (${p.type})`);
  return entries.length ? `Properties in this data source: ${entries.join(", ")}.` : "This data source has no properties.";
}

function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function plain(rich: RichTextItemResponse[] | undefined): string {
  return (rich ?? []).map((item) => item.plain_text).join("");
}

// Characters Markdown would read as syntax, escaped so text renders as typed.
function escapeText(text: string): string {
  return text.replace(/[\\`*_{}[\]<>#+!|~]/g, (char) => `\\${char}`);
}

function richText(rich: RichTextItemResponse[] | undefined): string {
  return (rich ?? [])
    .map((item) => {
      if (item.type === "equation") return `\`${item.equation.expression}\``;
      let text = item.annotations.code ? `\`${item.plain_text.replace(/`/g, "")}\`` : escapeText(item.plain_text);
      if (!item.annotations.code) {
        const { bold, italic, strikethrough } = item.annotations;
        const lead = text.match(/^\s*/)![0];
        const trail = text.match(/\s*$/)![0];
        let core = text.trim();
        if (core) {
          if (strikethrough) core = `~~${core}~~`;
          if (italic) core = `_${core}_`;
          if (bold) core = `**${core}**`;
        }
        text = `${lead}${core}${trail}`;
      }
      const href = item.href;
      return href ? `[${text}](${href})` : text;
    })
    .join("");
}

const CODE_LANGUAGES: Record<string, string> = { "plain text": "text", "c++": "cpp", "c#": "csharp", shell: "sh" };

async function mapLimit<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

interface Tree {
  block: BlockObjectResponse;
  children: Tree[];
}

async function blockTree(notion: Client, blockId: string): Promise<Tree[]> {
  const out: Tree[] = [];
  for await (const block of iteratePaginatedAPI(notion.blocks.children.list, { block_id: blockId })) {
    if (!isFullBlock(block)) continue;
    // A child page or database is a page of its own, not this page's content.
    const nested = block.has_children && block.type !== "child_page" && block.type !== "child_database";
    out.push({ block, children: nested ? await blockTree(notion, block.id) : [] });
  }
  return out;
}

/** Lower a block tree to Markdown. Unsupported blocks become plain text with a warning. */
export function blocksToMarkdown(trees: Tree[], warn: (type: string) => void, indent = ""): string {
  const lines: string[] = [];
  const push = (text: string) => lines.push(text.split("\n").map((line) => (line ? indent + line : line)).join("\n"));
  let previousList = "";
  for (const { block, children } of trees) {
    const listType = block.type === "bulleted_list_item" || block.type === "numbered_list_item" || block.type === "to_do" ? block.type : "";
    if (lines.length && !(listType && listType === previousList)) lines.push("");
    previousList = listType;
    const nested = (extra: string) => (children.length ? `\n${blocksToMarkdown(children, warn, extra)}` : "");
    switch (block.type) {
      case "paragraph":
        push(richText(block.paragraph.rich_text) + nested("  ").replace(/^\n/, "\n\n"));
        break;
      case "heading_1":
        push(`## ${richText(block.heading_1.rich_text)}`);
        break;
      case "heading_2":
        push(`### ${richText(block.heading_2.rich_text)}`);
        break;
      case "heading_3":
        push(`#### ${richText(block.heading_3.rich_text)}`);
        break;
      case "bulleted_list_item":
        push(`- ${richText(block.bulleted_list_item.rich_text)}${nested("  ")}`);
        break;
      case "numbered_list_item":
        push(`1. ${richText(block.numbered_list_item.rich_text)}${nested("   ")}`);
        break;
      case "to_do":
        push(`- [${block.to_do.checked ? "x" : " "}] ${richText(block.to_do.rich_text)}${nested("  ")}`);
        break;
      case "quote":
        push(`> ${richText(block.quote.rich_text)}${children.length ? `\n>\n${blocksToMarkdown(children, warn).replace(/^/gm, "> ")}` : ""}`);
        break;
      case "callout": {
        // Markdown has no callouts in Nimbus: a blockquote with a bold label.
        const body = richText(block.callout.rich_text);
        push(`> **Note:** ${body}${children.length ? `\n>\n${blocksToMarkdown(children, warn).replace(/^/gm, "> ")}` : ""}`);
        break;
      }
      case "code": {
        const language = CODE_LANGUAGES[block.code.language] ?? block.code.language.replace(/\s+/g, "-");
        const code = plain(block.code.rich_text);
        const fence = code.includes("```") ? "````" : "```";
        push(`${fence}${language}\n${code}\n${fence}`);
        break;
      }
      case "divider":
        push("---");
        break;
      case "image": {
        const url = block.image.type === "external" ? block.image.external.url : block.image.file.url;
        push(`![${escapeText(plain(block.image.caption))}](${url})`);
        break;
      }
      case "bookmark":
      case "embed":
      case "link_preview": {
        const url = block.type === "bookmark" ? block.bookmark.url : block.type === "embed" ? block.embed.url : block.link_preview.url;
        push(`[${escapeText(url)}](${url})`);
        break;
      }
      case "table": {
        const rows = children
          .map(({ block: row }) => (row.type === "table_row" ? row.table_row.cells.map((cell) => richText(cell).replace(/\n/g, " ")) : []))
          .filter((cells) => cells.length);
        if (rows.length) {
          const width = Math.max(...rows.map((cells) => cells.length));
          const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
          push([line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n"));
        }
        break;
      }
      case "child_page":
      case "child_database":
        warn(block.type);
        break;
      default: {
        warn(block.type);
        const value = (block as unknown as Record<string, { rich_text?: RichTextItemResponse[] } | undefined>)[block.type];
        const text = escapeText(plain(value?.rich_text));
        const rest = children.length ? blocksToMarkdown(children, warn) : "";
        push([text, rest].filter(Boolean).join("\n\n"));
      }
    }
  }
  return lines.join("\n");
}

function token(options: NotionLoaderOptions): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const value = options.token ?? env?.NOTION_TOKEN ?? process.env.NOTION_TOKEN;
  if (!value) {
    fail("NOTION_TOKEN is not set. Create an internal connection at https://www.notion.so/profile/integrations, share the database with it, and set NOTION_TOKEN in the build's environment (or .env locally).");
  }
  return value;
}

async function resolveDataSource(notion: Client, options: NotionLoaderOptions): Promise<string> {
  if (options.dataSource) {
    if (options.database) {
      const source = (await notion.dataSources.retrieve({ data_source_id: options.dataSource })) as { parent?: { database_id?: string } };
      const parent = source.parent?.database_id?.replace(/-/g, "");
      if (parent && parent !== options.database.replace(/-/g, "")) {
        fail(`data source ${options.dataSource} doesn't belong to database ${options.database}.`);
      }
    }
    return options.dataSource;
  }
  if (!options.database) fail("set `database` (or `dataSource`).");
  const database = (await notion.databases.retrieve({ database_id: options.database })) as {
    data_sources?: Array<{ id: string; name: string }>;
  };
  const sources = database.data_sources ?? [];
  if (sources.length === 1) return sources[0]!.id;
  if (sources.length === 0) fail(`database ${options.database} has no data source.`);
  fail(
    `database ${options.database} has ${sources.length} data sources; set \`dataSource\` to one of: ` +
      sources.map((s) => `${s.name} (${s.id})`).join(", ") +
      ".",
  );
}

interface PropertyPlan {
  title: string;
  description?: string;
  slug?: string;
  order?: string;
  status?: { name: string; type: "status" | "select" | "checkbox"; published: string };
}

function planProperties(properties: Record<string, Property>, options: NotionLoaderOptions, log: Logger): PropertyPlan {
  const byName = new Map(Object.values(properties).map((p) => [p.name, p]));
  const title = Object.values(properties).find((p) => p.type === "title");
  if (!title) fail(`the data source has no title property. ${listProperties(properties)}`);
  const named = options.properties ?? {};
  const plan: PropertyPlan = { title: title.name };
  const pick = (key: "description" | "slug" | "order", type: string) => {
    const explicit = named[key];
    const name = explicit ?? DEFAULT_PROPERTIES[key];
    const property = byName.get(name);
    if (!property) {
      if (explicit) fail(`property "${name}" (properties.${key}) doesn't exist. ${listProperties(properties)}`);
      return;
    }
    if (property.type !== type) {
      if (explicit) fail(`property "${name}" (properties.${key}) is ${property.type}; it must be ${type}. ${listProperties(properties)}`);
      log.warn(`notionLoader: property "${name}" is ${property.type}, not ${type}; it isn't used as ${key}.`);
      return;
    }
    plan[key] = name;
  };
  pick("description", "rich_text");
  pick("slug", "rich_text");
  pick("order", "number");

  const statusName = named.status ?? DEFAULT_PROPERTIES.status;
  const statusExplicit = named.status !== undefined || options.publishedValue !== undefined;
  const status = byName.get(statusName);
  if (!status) {
    if (statusExplicit) {
      fail(`the publishing property "${statusName}" doesn't exist. ${listProperties(properties)}`);
    }
    log.info(`notionLoader: no "${statusName}" property, so every row publishes.`);
    return plan;
  }
  if (status.type !== "status" && status.type !== "select" && status.type !== "checkbox") {
    fail(`property "${statusName}" is ${status.type}; the publishing property must be status, select or checkbox. ${listProperties(properties)}`);
  }
  if (status.type === "checkbox" && options.publishedValue !== undefined) {
    fail(`property "${statusName}" is a checkbox, which has no values; remove publishedValue.`);
  }
  plan.status = { name: statusName, type: status.type, published: options.publishedValue ?? "Published" };
  return plan;
}

function propertyValue(page: PageObjectResponse, name: string): PageObjectResponse["properties"][string] | undefined {
  return page.properties[name];
}

function isPublished(page: PageObjectResponse, status: NonNullable<PropertyPlan["status"]>): boolean {
  const value = propertyValue(page, status.name);
  if (!value) return false;
  if (value.type === "checkbox") return value.checkbox;
  if (value.type === "status") return value.status?.name === status.published;
  if (value.type === "select") return value.select?.name === status.published;
  return false;
}

function rateLimitHint(error: unknown): string {
  if (error instanceof APIResponseError && error.code === "rate_limited") {
    const reason = error.additional_data?.rate_limit_reason;
    return ` Notion rate-limited the requests${reason ? ` (${String(reason)})` : ""}; rebuild later.`;
  }
  return "";
}

export function notionLoader(options: NotionLoaderOptions): Loader {
  return {
    name: "notion",
    async load({ store, parseData, renderMarkdown, generateDigest, logger }) {
      const notion = new Client({
        auth: token(options),
        retry: { maxRetries: 5 },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      let entries: Array<{ id: string; pageId: string; title: string; data: Record<string, unknown>; body: string }>;
      try {
        const dataSourceId = await resolveDataSource(notion, options);
        const source = (await notion.dataSources.retrieve({ data_source_id: dataSourceId })) as { properties: Record<string, Property> };
        const plan = planProperties(source.properties, options, logger);

        const pages: PageObjectResponse[] = [];
        for await (const row of iterateAllDataSourceRows(notion, { data_source_id: dataSourceId })) {
          if (isFullPage(row as PageObjectResponse)) pages.push(row as PageObjectResponse);
        }
        const warned = new Set<string>();
        entries = await mapLimit(pages, options.concurrency ?? 3, async (page) => {
          const titleValue = propertyValue(page, plan.title);
          const title = titleValue?.type === "title" ? plain(titleValue.title) : "";
          const slugValue = plan.slug ? propertyValue(page, plan.slug) : undefined;
          const slug = slugValue?.type === "rich_text" ? plain(slugValue.rich_text).trim() : "";
          const id = slug ? slug.replace(/^\/+|\/+$/g, "") : slugify(title);
          if (!id) {
            fail(`Notion page ${page.id} has no Slug and its title ${title ? `"${title}" ` : ""}gives no URL; set its Slug or title.`);
          }
          const descriptionValue = plan.description ? propertyValue(page, plan.description) : undefined;
          const orderValue = plan.order ? propertyValue(page, plan.order) : undefined;
          const body = blocksToMarkdown(await blockTree(notion, page.id), (type) => {
            if (warned.has(type)) return;
            warned.add(type);
            logger.warn(`notionLoader: "${type}" blocks have no Markdown form; their plain text is kept.`);
          });
          const data: Record<string, unknown> = { title };
          if (descriptionValue?.type === "rich_text" && plain(descriptionValue.rich_text)) {
            data.description = plain(descriptionValue.rich_text);
          }
          if (orderValue?.type === "number" && orderValue.number !== null) data.sidebar = { order: orderValue.number };
          if (plan.status && !isPublished(page, plan.status)) data.draft = true;
          return { id, pageId: page.id, title, data, body };
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("notionLoader:")) throw error;
        const message = error instanceof Error ? error.message : String(error);
        fail(`reading Notion failed, nothing was written: ${message}.${rateLimitHint(error)}`);
      }

      // Duplicates are checked before anything is written: Nimbus can't tell
      // a collision from an update in a loader with no files.
      const byId = new Map<string, (typeof entries)[number]>();
      for (const entry of entries) {
        const other = byId.get(entry.id);
        if (other) {
          fail(
            `two Notion pages give the URL id "${entry.id}": ${other.pageId} ("${other.title}") and ${entry.pageId} ("${entry.title}"). Give one a different Slug.`,
          );
        }
        byId.set(entry.id, entry);
      }

      for (const entry of entries) {
        const data = await parseData({ id: entry.id, data: entry.data });
        store.set({
          id: entry.id,
          data,
          body: entry.body,
          rendered: await renderMarkdown(entry.body),
          digest: generateDigest(`${JSON.stringify(entry.data)}\n${entry.body}`),
        });
      }
      for (const id of store.keys()) if (!byId.has(id)) store.delete(id);
    },
  };
}
