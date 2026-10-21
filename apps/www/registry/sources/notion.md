---
{
  "name": "notion",
  "type": "registry:source",
  "title": "Notion database",
  "description": "Pages from a Notion database: title, description, slug, order and publishing from its properties."
}
---

# Add a Notion database as a content source

**Before anything else, tell the user:** pages from Notion are Markdown. They
get routes, the sidebar, search, Markdown twins and `llms.txt` like any page,
but no MDX components, no callouts (a Notion callout becomes a quote), no
edit link and no last-updated date. If they need those, the pages belong in
the repository.

You write the loader into the project from this guide: it reads the database
with `@notionhq/client` and turns each page into Markdown with
`notion-to-md`. The file is the user's to edit afterwards.

## 1. Discovery (read-only)

1. Find the Nimbus config (`defineNimbusConfig(` in `astro.config.ts` or
   `nimbus.config.ts`) and read `src/content.config.ts`.
2. Note the package manager (the lockfile: `pnpm-lock.yaml`, `package-lock.json`,
   `yarn.lock`, `bun.lock` or `bun.lockb`), and whether `src/loaders/notion.ts` already
   exists. If it does, it is the user's: ask before replacing it.

## 2. Ask the user

1. **The database.** Its id is the 32-character hex string in the database's
   URL (`notion.so/<workspace>/<id>?v=…`).
2. **The token.** Create an internal connection at
   https://www.notion.so/profile/integrations with "Read content", then share
   the database with it (the database's `•••` menu, "Connections"). Put the
   token in `NOTION_TOKEN`: `.env` locally (check `.env` is gitignored), and
   the build's environment in CI. Never in code.
3. **The collection name and URL prefix**, for example `handbook` at `/handbook`.
4. **The publishing value.** Notion creates a status property with Not started,
   In progress and Done. Ask which value means published; if it isn't
   `Published`, pass `publishedValue` (for example `publishedValue: "Done"`).
   Otherwise every row is a draft and the build warns that nothing published.
5. **The properties.** Defaults, by name: `Description` (rich text),
   `Slug` (rich text, the page's URL; else the slugified title), `Order`
   (number, sidebar order), `Status` (status, select or checkbox; a row
   publishes when it is `Published`, or checked). Ask if theirs differ.

## 3. Install the packages and write the loader

Install with the project's package manager, for example
`pnpm add @notionhq/client@^5 notion-to-md@^3`.

Write `src/loaders/notion.ts`:

```ts
/**
 * A Notion database as a Nimbus page collection. This file is yours: edit it freely.
 * Rows come from @notionhq/client; each page's blocks become Markdown through notion-to-md.
 */
import { APIResponseError, Client, isFullPage, iterateAllDataSourceRows } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import type { Loader } from "astro/loaders";
import { NotionToMarkdown } from "notion-to-md";

export interface NotionLoaderOptions {
  /** The database to read; its data source is used when it has exactly one. */
  database?: string;
  /** Read this data source directly instead. */
  dataSource?: string;
  /** Default: the NOTION_TOKEN environment variable. */
  token?: string;
  /** Property names, when yours differ from the defaults. */
  properties?: { description?: string; slug?: string; order?: string; status?: string };
  /** The status or select value that publishes a row. Default "Published". */
  publishedValue?: string;
  /** The fetch the Notion client uses (tests, proxies). */
  fetch?: typeof fetch;
}

type Property = PageObjectResponse["properties"][string];

const fail = (message: string): never => {
  throw new Error(`notionLoader: ${message}`);
};

const plain = (property: Property | undefined): string =>
  property?.type === "title"
    ? property.title.map((t) => t.plain_text).join("").trim()
    : property?.type === "rich_text"
      ? property.rich_text.map((t) => t.plain_text).join("").trim()
      : "";

const slugify = (value: string) =>
  value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Text an editor typed renders as typed: `<Client>`, `{props}`, `*stars*`, `1999.` and `$5` aren't markup. */
const escapeTyped = (text: string) =>
  text
    .replace(/[\\`*_{}[\]<>#+!|~$^&=]/g, "\\$&")
    .replace(/:(?=[\w{:/])/g, "\\:")
    .replace(/\bwww\./g, "www\\.")
    .replace(/^[ \t]{4,}|(?<=\n)[ \t]+/g, "")
    .replace(/(^|\n)([ \t]*)(\d+)([.)])/g, "$1$2$3\\$4")
    .replace(/(^|\n)([ \t]*)-/g, "$1$2\\-");

/** The page title is the page's `#`: every heading moves down one level, outside code. */
function demoteHeadings(markdown: string): string {
  let fence = "";
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (marker) {
        // A fence closes only on a bare line of its own character, at least as long.
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = "";
        return line;
      }
      return !fence && /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join("\n");
}

export function notionLoader(options: NotionLoaderOptions): Loader {
  const names = { description: "Description", slug: "Slug", order: "Order", status: "Status", ...options.properties };
  const publishedValue = options.publishedValue ?? "Published";

  return {
    name: "notion",
    async load({ store, parseData, renderMarkdown, generateDigest, logger }) {
      // `.env` reaches the loader through import.meta.env; a CI variable through process.env.
      const env = (import.meta as { env?: Record<string, string | undefined> }).env;
      const auth = options.token ?? env?.NOTION_TOKEN ?? process.env.NOTION_TOKEN;
      if (!auth) fail("NOTION_TOKEN is not set: put it in .env locally, and in the build's environment in CI.");
      const notion = new Client({ auth, retry: { maxRetries: 5 }, ...(options.fetch ? { fetch: options.fetch } : {}) });
      const n2m = new NotionToMarkdown({ notionClient: notion, config: { parseChildPages: true } });
      const annotate = n2m.annotatePlainText.bind(n2m);
      n2m.annotatePlainText = (text, annotations) => annotate(annotations.code ? text : escapeTyped(text), annotations);
      // Blocks with no Markdown form, and a row's sub-pages, would vanish silently: name them once.
      // (notion-to-md skips sub-pages before any transformer unless parseChildPages is on.)
      const dropped = new Set<string>();
      for (const type of ["audio", "table_of_contents", "breadcrumb", "child_page"]) {
        n2m.setCustomTransformer(type, () => (dropped.add(type), ""));
      }
      // A bookmark links with its caption, else its URL.
      n2m.setCustomTransformer("bookmark", (block) => {
        if (!("type" in block) || block.type !== "bookmark") return false;
        const caption = block.bookmark.caption.map((t) => t.plain_text).join("").trim();
        return `[${escapeTyped(caption || block.bookmark.url)}](${block.bookmark.url})`;
      });

      // Read everything before writing anything: a failed request fails the
      // load and leaves the last good content in place.
      const pages: Array<{ id: string; pageId: string; title: string; status: string; data: Record<string, unknown>; body: string }> = [];
      try {
        let dataSource = options.dataSource;
        if (!dataSource) {
          if (!options.database) fail("set `database` (or `dataSource`).");
          const database = (await notion.databases.retrieve({ database_id: options.database! })) as {
            data_sources?: Array<{ id: string; name: string }>;
          };
          let sources = database.data_sources ?? [];
          if (sources.length > 1) {
            // The database lists trashed data sources too; only retrieving one says so.
            const trashed = await Promise.all(
              sources.map(async (s) => ((await notion.dataSources.retrieve({ data_source_id: s.id })) as { in_trash?: boolean }).in_trash),
            );
            sources = sources.filter((_, i) => !trashed[i]);
          }
          if (sources.length !== 1) {
            fail(`database ${options.database} has ${sources.length} data sources; set \`dataSource\` to one of: ${sources.map((s) => `${s.name} (${s.id})`).join(", ")}.`);
          }
          dataSource = sources[0]!.id;
        }

        // Named properties must exist with a type the loader reads; the
        // publishing rule fails closed.
        const source = (await notion.dataSources.retrieve({ data_source_id: dataSource })) as {
          properties: Record<string, { name: string; type: string }>;
          parent?: { database_id?: string };
        };
        const bare = (id: string) => id.replace(/-/g, "");
        if (options.database && options.dataSource && bare(source.parent?.database_id ?? "") !== bare(options.database)) {
          fail(`data source ${options.dataSource} doesn't belong to database ${options.database}.`);
        }
        const { properties } = source;
        const listed = Object.values(properties).map((p) => `${p.name} (${p.type})`).join(", ");
        const types = { description: "rich_text", slug: "rich_text", order: "number" } as const;
        for (const key of ["description", "slug", "order"] as const) {
          const property = properties[names[key]];
          if (!property) {
            if (options.properties?.[key]) fail(`property "${names[key]}" (properties.${key}) doesn't exist. Properties: ${listed}.`);
            continue;
          }
          if (property.type !== types[key]) {
            fail(`property "${names[key]}" is ${property.type}; it must be ${types[key]}. Change its type, or point properties.${key} at another property.`);
          }
        }
        const status = properties[names.status];
        if (!status && (options.properties?.status || options.publishedValue)) {
          fail(`the publishing property "${names.status}" doesn't exist. Properties: ${listed}.`);
        }
        if (status && !["status", "select", "checkbox"].includes(status.type)) {
          fail(`property "${names.status}" is ${status.type}; the publishing property must be status, select or checkbox.`);
        }
        if (status?.type === "checkbox" && options.publishedValue) {
          fail(`property "${names.status}" is a checkbox, which has no values; remove publishedValue.`);
        }
        // A renamed status property must not publish every draft.
        const renamed = status ? undefined : Object.values(properties).find((p) => p.type === "status");
        if (renamed) {
          fail(`there's no "${names.status}" property, but "${renamed.name}" is a status property. Set properties.status: "${renamed.name}", or rename it back.`);
        }
        if (!status) logger.info(`notionLoader: no "${names.status}" property, so every row publishes.`);

        for await (const row of iterateAllDataSourceRows(notion, { data_source_id: dataSource })) {
          if (!isFullPage(row as PageObjectResponse)) continue;
          const page = row as PageObjectResponse;
          const title = plain(Object.values(page.properties).find((p) => p.type === "title"));
          const id = plain(page.properties[names.slug]).replace(/^\/+|\/+$/g, "") || slugify(title);
          if (!id) fail(`Notion page ${page.id} has no Slug and its title gives no URL; set its Slug or title.`);
          const value = page.properties[names.status];
          const statusText = value?.type === "status" ? (value.status?.name ?? "") : value?.type === "select" ? (value.select?.name ?? "") : "";
          const published = !status || (value?.type === "checkbox" ? value.checkbox : statusText === publishedValue);
          const order = page.properties[names.order];
          const description = plain(page.properties[names.description]);
          const markdown = n2m.toMarkdownString(await n2m.pageToMarkdown(page.id)).parent ?? "";
          pages.push({
            id,
            pageId: page.id,
            title,
            status: statusText,
            body: `${demoteHeadings(markdown).trim()}\n`,
            data: {
              title,
              ...(description ? { description } : {}),
              ...(order?.type === "number" && order.number !== null ? { sidebar: { order: order.number } } : {}),
              ...(published ? {} : { draft: true }),
            },
          });
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("notionLoader:")) throw error;
        const limited = error instanceof APIResponseError && error.code === "rate_limited" ? " Notion rate-limited the requests; rebuild later." : "";
        const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
        fail(`reading Notion failed, nothing was written: ${message}.${limited}`);
      }

      if (dropped.size > 0) {
        logger.warn(`notionLoader: ${[...dropped].join(", ")} blocks were left out (no Markdown form, and a row's sub-pages aren't pages of the collection); a notion-to-md custom transformer can render them.`);
      }

      if (pages.length > 0 && pages.every((page) => page.data.draft)) {
        const seen = [...new Set(pages.map((page) => page.status).filter(Boolean))].map((v) => `"${v}"`).join(", ");
        logger.warn(
          `notionLoader: no row is published (a row publishes when its status is "${publishedValue}"` +
            `${seen ? `; this database uses ${seen}. Set publishedValue to the one that means published` : ""}).`,
        );
      }

      // Without files, Nimbus can't tell a duplicate from an update: check before writing.
      const byId = new Map<string, (typeof pages)[number]>();
      for (const page of pages) {
        const other = byId.get(page.id);
        if (other) fail(`two Notion pages give the URL id "${page.id}": ${other.pageId} ("${other.title}") and ${page.pageId} ("${page.title}"). Give one a different Slug.`);
        byId.set(page.id, page);
      }
      // Parse and render every page, then write: a page that fails the schema leaves the store as it was.
      const entries = [];
      for (const page of pages) {
        entries.push({
          id: page.id,
          data: await parseData({ id: page.id, data: page.data }),
          body: page.body,
          rendered: await renderMarkdown(page.body),
          digest: generateDigest(`${JSON.stringify(page.data)}\n${page.body}`),
        });
      }
      for (const entry of entries) store.set(entry);
      for (const id of store.keys()) if (!byId.has(id)) store.delete(id);
    },
  };
}
```

## 4. Register the collection

```ts
// src/content.config.ts
import { docsCollection, withNimbusMarkdown } from "@cloudflare/nimbus-docs/content";
import { notionLoader } from "./loaders/notion";

handbook: defineCollection({
  loader: withNimbusMarkdown(notionLoader({ database: "<database id>" })),
  schema: docsCollection().schema,
}),
```

Different property names: `notionLoader({ database, properties: { slug: "URL",
status: "State" }, publishedValue: "Live" })`. A database with several data
sources fails listing them; pick one with `dataSource: "<id>"`.

### Route, rendering and sidebar

Do these for each new collection (`<collection>` is its name, and its URL prefix).

**Route.** Write `src/pages/<collection>/[...slug].astro`. If `src/pages/[...slug].astro`
renders a different layout than this, mirror its imports and props instead:

```astro
---
import DocsLayout from "@/layouts/DocsLayout.astro";
import {
  getCollectionStaticPaths,
  getCollectionPage,
  getSidebar,
  getPrevNext,
  getBreadcrumbs,
  getEditUrl,
  getLastUpdated,
  getRouteFlags,
  getTOC,
  stripBase,
} from "@cloudflare/nimbus-docs/runtime";
import { components } from "@/components";

export const getStaticPaths = getCollectionStaticPaths("<collection>");

const page = await getCollectionPage(Astro, "<collection>");
if (page instanceof Response) return page;
const { entry, Content, headings, markdownUrl, ogImageUrl } = page;

const currentSlug = stripBase(Astro.url.pathname, import.meta.env.BASE_URL).replace(/\/$/, "") || "/";
const { tableOfContents: tocOn } = await getRouteFlags(entry);
// Pass collection so the sidebar/prev-next resolve against the current
// collection's tree. Critical for version pages — without this, version
// pages render the current docs sidebar with wrong prev/next.
const sidebar = await getSidebar(currentSlug, { collection: entry.collection });
const prevNext = await getPrevNext(currentSlug, {
  sidebarTree: sidebar,
  overrides: { prev: entry.data.prev, next: entry.data.next },
});
const breadcrumbs = await getBreadcrumbs(currentSlug, { collection: entry.collection });
const editUrl = await getEditUrl(entry);
const lastUpdated = entry.data.lastUpdated ??
  await getLastUpdated(entry);
const tocConfig = entry.data.tableOfContents;
const toc = tocOn && tocConfig !== false ? getTOC(headings, tocConfig) : false;
const socialImage = entry.data.socialImage ?? ogImageUrl;
---

<DocsLayout
  title={entry.data.title}
  description={entry.data.description}
  sidebar={sidebar}
  headings={toc}
  breadcrumbs={breadcrumbs}
  prevNext={prevNext}
  mode={entry.data.mode}
  banner={entry.data.banner}
  head={entry.data.head}
  searchable={entry.data.searchable}
  noindex={entry.data.noindex}
  markdownUrl={markdownUrl}
  socialImage={socialImage}
  lastUpdated={lastUpdated}
  editUrl={editUrl}
  draft={entry.data.draft}
  collection={entry.collection}
  entryId={entry.id}
>
  <Content components={components} />
</DocsLayout>
```

**Rendering.** If the Nimbus config sets `rendering` (a Cloudflare site with server output sets
`rendering: { default: "request" }`), add the collection to `rendering.collections`, or the
build fails: `collections: { <collection>: "request" }` (or `"build"` to prerender it). Without
a `rendering` option, skip this. The route above is written for a site built ahead of time on
`output: "static"`; run `nimbus-docs check --fix` so it matches the site's `rendering` and `output`.

**Sidebar.** Ask the user whether the collection goes in the sidebar, and where. If the Nimbus
config has `sidebar.items`, add `{ label: "<Display Name>", autogenerate: { collection: "<collection>" } }`.
If it has none, the sidebar shows only `docs` today, and adding `sidebar.items` replaces that
default: add both, `{ label: "Docs", autogenerate: { collection: "docs" } }` first.

**Section tab.** The collection's own URL (`/<collection>/`) is its `index.md`. If it has none,
tell the user the starter's section tab for it will 404, and suggest adding an index page.


## 5. What the publishing rule does

| The database | Result |
|---|---|
| No `Status` property, nothing configured | every row publishes (one info line says so) |
| No `Status` property, but a status property under another name | the build fails naming it: set `properties.status` |
| `Status` present | a row that isn't `Published` (or unchecked) is a draft: shown in `astro dev` with the Draft badge, absent from `astro build` |
| A named property missing or of the wrong type | the build fails, listing the data source's properties |

Two rows with one slug, or a row with no slug and an empty title, fail the
build naming the Notion page ids. Without a `Slug`, renaming a page's title
changes its URL.

## 6. Verify

1. `astro dev`: the pages render, drafts show the badge.
2. `astro build`: drafts are gone.
3. Remove `NOTION_TOKEN`: the build fails naming it.
4. If the build warns that no row is published, the publishing value is wrong:
   set `publishedValue` to the value the warning lists.

**Report to the user:** the collection and its URL, how many pages published and how many are
drafts, where `NOTION_TOKEN` must be set for deploys, and that
the site changes only when it rebuilds.

## Notes for the agent

- A Notion equation becomes `$$…$$` math. Unless the site turns on
  `markdown.features.math` with the `math()` plugin, it shows as TeX source.
- Notion file URLs (images uploaded to Notion) expire after an hour; images
  that must last belong on a host of their own.
- The site doesn't update when Notion does: rebuild on a schedule, or from a
  Notion webhook through an automation to the deploy hook.
- `nimbus-docs lint` and `check` don't read Notion; they name the collection
  as not inspected.
- Notion limits each connection to about three requests a second; the
  loader retries rate limits, and server errors while reading page content.
  A build that still fails wrote nothing and can be rerun.
- Audio, tables of contents, breadcrumbs and a row's sub-pages (which aren't
  pages of the collection) are left out, and the build warns naming them. So
  are blocks the Notion API can't return, without a warning.
  To render a block type your way, add
  `n2m.setCustomTransformer("<block type>", async (block) => "<markdown>")`
  in the loader.
