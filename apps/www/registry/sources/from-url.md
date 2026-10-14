---
{
  "name": "from-url",
  "type": "registry:source",
  "title": "Any other provider",
  "description": "Write a loader for a provider Nimbus doesn't ship, starting from its documentation URL.",
  "url": true
}
---

# Add a content source Nimbus doesn't ship

You are helping the user build part of their Nimbus docs site from a
provider Nimbus has no source for: a CMS, a knowledge base, an internal API.
The `Research start:` line above this heading is the provider's
documentation the user pointed you at; read it first, for authentication,
listing pages, and fetching each page's content.

**If that URL is a git repository** (a GitHub, GitLab or Bitbucket URL, or
any `.git` remote), stop: run `nimbus-docs add source git --print` and follow
that guide instead. Nimbus checks git repositories out itself.

## What you will build

An Astro content loader in `src/loaders/<provider>.ts`, wrapped with Nimbus's
`withNimbusMarkdown()`, registered as a collection. Wrapped, its pages get
routes, the sidebar, Markdown twins, `llms.txt`, search, API citations,
authored links and URL collision checks, like any local page. Pages are
Markdown only: no MDX components, no callouts, no edit link, no git date.

## 1. Discovery (read-only)

1. Find the Nimbus config (`defineNimbusConfig(` in `astro.config.ts` or
   `nimbus.config.ts`) and read `src/content.config.ts`.
2. From the provider's docs: how to authenticate (an API token in an
   environment variable, never in the code), how to list the pages, how to get
   one page's content, and whether the content is Markdown, HTML or blocks.

## 2. The loader contract

Write a loader whose `load({ store, parseData, renderMarkdown, generateDigest, logger })`:

1. **Fetches everything before writing anything.** Collect every page first;
   if a request fails after retries, throw. The store keeps its last good
   content in dev, and a build fails instead of publishing half a site.
2. **Derives each entry's id** from a slug field, else the slugified title.
   An empty id is an error naming the provider's page id.
3. **Checks duplicates before writing:** two pages with one id is an error
   naming both provider page ids. Nimbus can't tell a duplicate from an
   update in a loader with no files, so the loader must.
4. **Writes each entry** with `data` parsed through `parseData` (title,
   description, `sidebar.order`, and `draft: true` for unpublished pages,
   which Nimbus shows in dev and drops from production), the Markdown `body`,
   `rendered: await renderMarkdown(body)`, and `digest: generateDigest(body)`.
5. **Deletes every stored id** that isn't in the new set.
6. Lowers HTML or blocks to Markdown, escaping text so a `{`, `<` or `*` an
   editor typed renders as written.

Wire it:

```ts
// src/content.config.ts
import { docsCollection, withNimbusMarkdown } from "@cloudflare/nimbus-docs/content";
import { providerLoader } from "./loaders/provider";

handbook: defineCollection({
  loader: withNimbusMarkdown(providerLoader({ /* options */ })),
  schema: docsCollection().schema,
}),
```

### Route, rendering and sidebar

Do these for each new collection (`<collection>` is its name, and its URL prefix).

**Route.** Write `src/pages/<collection>/[...slug].astro`. If `src/pages/[...slug].astro`
renders a different layout than this, mirror its imports and props instead:

```astro
---
import DocsLayout from "../../layouts/DocsLayout.astro";
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
import { components } from "../../components";

export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("<collection>");

const page = await getCollectionPage<"<collection>">(Astro);
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

**Rendering.** If the Nimbus config sets `rendering` (Cloudflare scaffolds set
`rendering: { default: "request" }`), add the collection to `rendering.collections`, or the
build fails: `collections: { <collection>: "request" }` (or `"build"` to prerender it). Without
a `rendering` option, skip this.

**Sidebar.** Ask the user whether the collection goes in the sidebar, and where. If the Nimbus
config has `sidebar.items`, add `{ label: "<Display Name>", autogenerate: { collection: "<collection>" } }`.
If it has none, the sidebar shows only `docs` today, and adding `sidebar.items` replaces that
default: add both, `{ label: "Docs", autogenerate: { collection: "docs" } }` first.

**Section tab.** The collection's own URL (`/<collection>/`) is its `index.md`. If it has none,
tell the user the starter's section tab for it will 404, and suggest adding an index page.


## 3. Verify against a local collection

1. Put one page's Markdown in `src/content/docs/parity-check.md` and the same
   page in the provider. Build, and compare the two pages' HTML and their
   `index.md` twins: they should match apart from the URL prefix.
2. A page with an `api.ref:` citation resolves to the API page.
3. Make two provider pages share a slug: the build fails naming both.
4. Unpublish a page: it shows in `astro dev` with the Draft badge and is
   absent from `astro build`.
5. Remove the token: the build fails naming the environment variable.
6. Delete the parity page afterwards.

**Report to the user:** what the loader reads and how it authenticates, the collection and its
URL, which checks above passed, and what doesn't carry over (no MDX components, no edit link,
not linted).

## Notes for the agent

- `nimbus-docs lint` and `check` read files on disk, so they don't see this
  collection; they name it as not inspected.
- Rebuild the site when the provider's content changes: a webhook from the
  provider to the deploy hook, or a schedule.
