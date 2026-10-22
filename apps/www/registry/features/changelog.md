---
{
  "name": "changelog",
  "type": "registry:feature",
  "title": "Changelog",
  "description": "Add a changelog at /changelog: release notes newest first, 10 a page with Newer / Older and a \"More releases\" list, a page per release with its sections in \"On this page\", Markdown versions with each release's date and tags, OG cards, and an optional RSS feed. For a docs-shaped tree use `nimbus-docs add new-collection`.",
  "markers": ["src/content/changelog/", "src/pages/changelog/index.astro"]
}
---

# Changelog

You are helping the user add a **changelog** to their Nimbus docs site:
release notes at `/changelog/`, newest first, ten to a page, with a page per
release. Each release is one Markdown or MDX file with a `date`, optional
`version` and `tags`, and a body. Read this entire file before making
changes.

A changelog is a dated list, not a docs tree. If the user wants a content
tree with a sidebar, stop and point them at `nimbus-docs add new-collection`.

The changelog is a normal docs-shaped collection with extra frontmatter
fields; there is no changelog schema or runtime in the framework. Every file
below is the user's own source to restyle.

## 1. Discovery (read-only)

- `package.json`: confirm `@cloudflare/nimbus-docs` is a dependency and note
  the package manager. If it isn't a Nimbus project, stop.
- `src/content.config.ts`: read it in full. Note the existing collections
  (don't collide) and the import style.
- `astro.config.ts`: read the Nimbus config. Note `title`, `description`,
  `locale` and `rendering`, and whether `output` is `"server"`.
- `src/layouts/DocsLayout.astro`: confirm it takes `sidebar`, `headings`,
  `prevNext`, `breadcrumbs`, `head` and `socialImage`, has `toc` and
  `pagination` slots, and centres the page when `sidebar` is `false` (a
  `w-(--nb-toc-width)` spacer). If it lacks any of these, it predates them:
  ask the user to update it with `nimbus-docs diff src/layouts/DocsLayout.astro --apply`
  if it is unmodified, and stop until it's current.
- `src/components/ui/pagination/` and `src/components/ui/toc/`: the pages
  use `Pagination` and `TOC` from them. If either is missing, run
  `npx @cloudflare/nimbus-docs add pagination` or `add toc` first.
- `src/pages/[...slug]/index.md.ts` and `src/pages/[...slug]/index.mdx.ts`:
  confirm they call `markdownRoute()` and `markdownSourceRoute()` from
  `@cloudflare/nimbus-docs/agent-endpoints`. These shared routes serve every
  release's `.md` and `.mdx`, with the fields from step 4, so the changelog
  needs no Markdown route of its own.
  If either instead passes `collection: "docs"` (an older starter), stop:
  the releases would get no Markdown versions. Ask the user to update it
  with `nimbus-docs diff <file> --apply` if it is unmodified, or to replace
  it with the three-line version from the `ai-native` recipe, wrapping it to
  keep any customizations.
- `src/components.ts`: the MDX globals registry. Release bodies render with
  it, so components work in releases as they do in docs.
- `src/pages/og/[...slug].ts`: confirm it enumerates entries with
  `getOgImagePages()`, as the starter's does (older starters use
  `getIndexedEntries()`, which also works). It then already generates
  `/og/changelog/<slug>.png` for every release, so releases need no OG route
  of their own. If it covers only the `docs` collection, extend it to every
  collection instead of adding a second `OGImageRoute` under `src/pages/og/`.
  The list pages aren't entries; they get one card in 5i.
- `src/pages/og/_card.ts`: the starter's card renderer. Older starters have
  `src/pages/og/_og-card-config.ts` and render with astro-og-canvas instead;
  5i shows both.

## 2. Prompt the user

Ask, with these defaults:

1. **Title and description**: `Changelog` and "New features, improvements
   and fixes, by release." Shown at the top of `/changelog/`.
2. **RSS feed?** Default **yes**. When no, skip everything marked "RSS
   only" below.
3. **Seed releases?** Default yes: one or two, so the pages render.

## 3. Plan

Print the files and the resulting URLs before writing, and wait for
confirmation. URLs: `/changelog/`, `/changelog/page/<n>/` (from the 11th
release), `/changelog/<slug>/`, its `index.md` and `index.mdx`,
`/changelog/llms.txt`, `/og/changelog.png`, and, if RSS was chosen,
`/changelog/rss.xml`.

You will **create**:

- `src/components/changelog/release.ts`
- `src/components/changelog/ChangelogEntry.astro`
- `src/components/changelog/ChangelogFeed.astro`
- `src/components/changelog/ChangelogPage.astro`
- `src/pages/changelog/index.astro`
- `src/pages/changelog/page/[page].astro`
- `src/pages/changelog/[...slug].astro`
- `src/pages/changelog/rss.xml.ts` (RSS only)
- `src/pages/og/changelog.png.ts`
- `src/content/changelog/<YYYY-MM-DD>-<slug>.md`: the seed releases.

You will **edit** `src/content.config.ts` and, if `rendering` is set, the
Nimbus config's `rendering.collections` (4a). If RSS was chosen, install
`@astrojs/rss@^4.0.19` with the project's package manager.

## 4. Register the collection

Add `changelog` to `collections`, keeping existing entries and import
style:

```ts
import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { docsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(docsCollection()),
  changelog: defineCollection(
    docsCollection({
      base: "changelog",
      schemaFields: {
        date: z.coerce.date({
          error: (iss) =>
            iss.input === undefined
              ? 'Missing required "date" in changelog frontmatter (e.g. 2026-06-16).'
              : '"date" must be a valid date (e.g. 2026-06-16).',
        }),
        // The release this entry shipped in, if the product has versions.
        version: z.string().optional(),
        tags: z.array(z.string()).default([]),
      },
      // Written into each release's .md and .mdx; `version` already is.
      markdownFields: ["date", "tags"],
    }),
  ),
};
```

Releases get `{ title, description?, date, version?, tags }` plus the docs
fields (`draft`, `noindex`, `socialImage`, `head`). Write `date` without a
time (`2026-06-16`), or with an offset: a time without one is read in the
build machine's timezone.

### 4a. Add the collection to the rendering policy (if one is set)

If the Nimbus config sets `rendering` (Cloudflare scaffolds do, with
`rendering: { default: "request" }`), add `changelog` to
`rendering.collections`. `rendering.default` doesn't cover a page collection
with its own catch-all route, so the build fails until it's listed:

```ts
rendering: {
  default: "request",
  collections: { changelog: "request" },
},
```

Use `"request"` to render release pages like the rest of a request-rendered
site, or `"build"` to prerender them. Without a `rendering` option, skip
this step. Only the release pages (5g) follow this mode; the list pages, the
feed and the OG card are prerendered on every site, since they change only
when content does.

## 5. Implementation

Copy these files as they are, with these substitutions only:

- the title and description from step 2, in `release.ts`;
- for a site that declined RSS, the edits marked "RSS only".

Dates are formatted in the site's `locale`, in UTC, so a release dated
`2026-07-02` shows July 2 everywhere. Spacing uses logical properties, so
the pages work right to left.

### 5a. `src/components/changelog/release.ts`

The one index: releases sorted once, newest first, split into pages, with an
anchor for every year and release on the list pages. Pages receive their
slice; nothing else sorts the collection.

```ts
/**
 * The changelog's one index: every release sorted once (newest first), split
 * into pages, with an anchor for each release and year on the list pages.
 * Pages read their slice from it; nothing else sorts the collection.
 */
import { getCollection, type CollectionEntry } from "astro:content";
import { config } from "virtual:nimbus/config";
import { entryRouteKey } from "@cloudflare/nimbus-docs/runtime";

export type Release = CollectionEntry<"changelog">;

/** The changelog page's title and description. */
export const CHANGELOG_TITLE = "Changelog";
export const CHANGELOG_DESCRIPTION = "New features, improvements and fixes, by release.";

/** Releases per changelog page. */
export const PAGE_SIZE = 10;

/** "More releases" lists every page up to this many, then a window. */
const ALL_PAGES_UP_TO = 20;

export interface ReleaseIndex {
  releases: Release[];
  pages: Release[][];
  /** Each release's anchor on the list pages, by entry id. */
  anchors: ReadonlyMap<string, string>;
  /** Each year's anchor on the list pages. */
  yearAnchors: ReadonlyMap<number, string>;
}

/** One list page and what it links to. */
export interface ChangelogPageData {
  page: number;
  pageCount: number;
  years: Array<{ year: number; anchor: string; releases: Array<{ entry: Release; anchor: string }> }>;
  range: string;
  newer?: { href: string; range: string };
  older?: { href: string; range: string };
  /** "More releases": other pages by range, with `null` where pages are skipped. */
  others: Array<{ href: string; range: string } | null>;
}

const lang = config.locale ?? "en";
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** A release date in the site's language, in UTC so a date-only value is that day everywhere. */
export function dateLabel(date: Date, month: "short" | "long" = "short"): string {
  let format = dateFormats.get(month);
  if (!format) {
    format = new Intl.DateTimeFormat(lang, { month, day: "numeric", year: "numeric", timeZone: "UTC" });
    dateFormats.set(month, format);
  }
  return format.format(date);
}

/** A release's name in the meta line, contents, breadcrumb and neighbour links. */
export const releaseLabel = (entry: Release) => entry.data.version ?? entry.data.title;

/** A release's end of a page range: its version, else its date. */
const rangeEnd = (entry: Release) => entry.data.version ?? dateLabel(entry.data.date);

/** A release's page, where the collection route serves it (`a/index` at `/changelog/a/`). */
export const releaseHref = (entry: Release) => `/changelog/${entryRouteKey(entry.id)}/`;

/** Page 1 is the changelog root; the rest live under /changelog/page/<n>/. */
export const pageHref = (page: number) => (page === 1 ? "/changelog/" : `/changelog/page/${page}/`);

/** The releases a page holds, newest to oldest: "2.12.0 – 2.3.0". */
export function rangeLabel(list: Release[]): string {
  if (list.length === 0) return "";
  const first = rangeEnd(list[0]);
  const last = rangeEnd(list[list.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

const slug = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "release";

/** Sorts, pages and anchors a list of releases. */
export function indexReleases(entries: Release[]): ReleaseIndex {
  const releases = [...entries].sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const pages: Release[][] = [];
  for (let i = 0; i < releases.length; i += PAGE_SIZE) pages.push(releases.slice(i, i + PAGE_SIZE));
  if (pages.length === 0) pages.push([]);

  // Years first, then releases in order; a taken id gets -2, -3, …
  const taken = new Set<string>();
  const allocate = (wanted: string) => {
    let id = wanted;
    for (let n = 2; taken.has(id); n++) id = `${wanted}-${n}`;
    taken.add(id);
    return id;
  };
  const yearAnchors = new Map<number, string>();
  for (const entry of releases) {
    const year = entry.data.date.getUTCFullYear();
    if (!yearAnchors.has(year)) yearAnchors.set(year, allocate(`y${year}`));
  }
  const anchors = new Map<string, string>();
  for (const entry of releases) {
    const { version } = entry.data;
    anchors.set(entry.id, allocate(version ? `v${slug(version.replaceAll(".", "-"))}` : slug(entry.id)));
  }
  return { releases, pages, anchors, yearAnchors };
}

let memo: Promise<ReleaseIndex> | undefined;

/**
 * The index, built once per build, or once per server instance for
 * request-rendered pages (content only changes with a deploy). Dev rebuilds
 * it on every request so edits show up.
 */
export function getReleaseIndex(): Promise<ReleaseIndex> {
  // The collection's index entry, if any, is /changelog/ itself, not a release.
  const build = async () =>
    indexReleases(await getCollection("changelog", (entry) => !entry.data.draft && entryRouteKey(entry.id) !== ""));
  if (import.meta.env.DEV) return build();
  return (memo ??= build());
}

/** Page numbers "More releases" links from `page`, with `null` for each gap. */
export function morePages(page: number, pageCount: number): Array<number | null> {
  const all = Array.from({ length: pageCount }, (_, i) => i + 1);
  const shown =
    pageCount <= ALL_PAGES_UP_TO
      ? all
      : all.filter((n) => n <= 3 || Math.abs(n - page) <= 2 || n > pageCount - 3);
  const out: Array<number | null> = [];
  let previous = 0;
  for (const n of shown) {
    if (n > previous + 1) out.push(null);
    previous = n;
    if (n !== page) out.push(n);
  }
  return out;
}

export function changelogPage(index: ReleaseIndex, page: number): ChangelogPageData {
  const list = index.pages[page - 1] ?? [];
  const years: ChangelogPageData["years"] = [];
  for (const entry of list) {
    const year = entry.data.date.getUTCFullYear();
    let group = years[years.length - 1];
    if (group?.year !== year) {
      group = { year, anchor: index.yearAnchors.get(year)!, releases: [] };
      years.push(group);
    }
    group.releases.push({ entry, anchor: index.anchors.get(entry.id)! });
  }
  const link = (n: number) => ({ href: pageHref(n), range: rangeLabel(index.pages[n - 1]) });
  return {
    page,
    pageCount: index.pages.length,
    years,
    range: rangeLabel(list),
    newer: page > 1 ? link(page - 1) : undefined,
    older: page < index.pages.length ? link(page + 1) : undefined,
    others: morePages(page, index.pages.length).map((n) => (n === null ? null : link(n))),
  };
}

/** A release's newer and older neighbours, for its own page. */
export function releaseNeighbours(index: ReleaseIndex, id: string) {
  const at = index.releases.findIndex((entry) => entry.id === id);
  return {
    newer: at > 0 ? index.releases[at - 1] : undefined,
    older: at >= 0 ? index.releases[at + 1] : undefined,
  };
}

const listDepth = (depth: number) => Math.min(6, Math.max(4, depth + 2));
// The references Markdown renderers write in ids and links; anything else,
// or a number past Unicode, stays as written.
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (value: string) =>
  value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (match, dec?: string, hex?: string, name?: string) => {
    if (!dec && !hex) return NAMED[name!.toLowerCase()] ?? match;
    const code = parseInt(dec ?? hex!, dec ? 10 : 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const ATTR = String.raw`\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\`]+))?`;
// Comments and the bodies of script, style and textarea pass through as they
// are; every other match is one tag, with its attributes.
const TOKEN = new RegExp(
  String.raw`<!--[\s\S]*?-->|<(script|style|textarea)(?:${ATTR})*\s*>[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:${ATTR})*)\s*(\/?)>`,
  "gi",
);
const ATTRS = new RegExp(String.raw`\s+([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>\`]+))?`, "g");
const attrValue = (raw: string | undefined) =>
  raw === undefined ? "" : unescape(/^["']/.test(raw) ? raw.slice(1, -1) : raw);

function eachTag(
  html: string,
  edit: (tag: { closing: boolean; name: string; attrs: string; selfClosing: string }) => string | undefined,
): string {
  return html.replace(TOKEN, (match, raw: string | undefined, closing: string, name: string, attrs: string, selfClosing: string) =>
    raw || match.startsWith("<!--") ? match : (edit({ closing: closing === "/", name, attrs, selfClosing }) ?? match),
  );
}

/**
 * A release body for a list page, where each release is an h3 under its
 * year: headings move down two levels (`h2` → `h4`, never above `h4` or
 * past `h6`) and lose their ids, since every release has its own "New".
 * Links to those ids go to the release's own page instead. Only heading tags
 * and `href` attributes change; scripts, styles and text are left alone.
 */
export function listPageBody(html: string, href: string): string {
  const removed = new Set<string>();
  const demoted = eachTag(html, ({ closing, name, attrs, selfClosing }) => {
    const depth = /^h([1-6])$/i.exec(name)?.[1];
    if (!depth) return undefined;
    const level = listDepth(Number(depth));
    if (closing) return `</h${level}>`;
    const kept = attrs.replace(ATTRS, (attr, attrName: string, raw: string | undefined) => {
      if (attrName.toLowerCase() !== "id") return attr;
      removed.add(attrValue(raw));
      return "";
    });
    return `<h${level}${kept}${selfClosing ? " /" : ""}>`;
  });
  if (removed.size === 0) return demoted;
  return eachTag(demoted, ({ closing, name, attrs, selfClosing }) => {
    if (closing) return undefined;
    let changed = false;
    const rewritten = attrs.replace(ATTRS, (attr, attrName: string, raw: string | undefined) => {
      if (attrName.toLowerCase() !== "href") return attr;
      const value = attrValue(raw);
      if (!value.startsWith("#")) return attr;
      let id = value.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {}
      if (!removed.has(id)) return attr;
      changed = true;
      return ` href="${escapeAttr(`${href}${value}`)}"`;
    });
    return changed ? `<${name}${rewritten}${selfClosing ? " /" : ""}>` : undefined;
  });
}
```

### 5b. `src/components/changelog/ChangelogEntry.astro`

One release on a list page. Its sections (`## New`, `## Fixed`) move below
the release's h3 and lose their ids there, since every release has its own
"New"; the release page is where sections are linkable.

```astro
---
/**
 * ChangelogEntry — one release on a list page: a meta line (version, date,
 * tags), the title as an h3 linking to the release's own page, then the body,
 * passed in as the default slot. The body's headings sit below the h3 and
 * carry no ids; the release page is where its sections are linkable.
 */
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { dateLabel, listPageBody, releaseHref, type Release } from "./release";

interface Props {
  entry: Release;
  /** The release's id on the list pages, from the index. */
  anchor: string;
}

const { entry, anchor } = Astro.props;
const { title, date, version, tags } = entry.data;
const href = withBase(releaseHref(entry), import.meta.env.BASE_URL);
const body = listPageBody(await Astro.slots.render("default"), href);
---

<section class="cl-release" aria-labelledby={anchor}>
  <p class="cl-meta">
    {version && <span class="cl-version">{version}</span>}
    <time datetime={date.toISOString().slice(0, 10)}>{dateLabel(date)}</time>
    {tags.length > 0 && <span>{tags.join(", ")}</span>}
  </p>
  <h3 id={anchor}><a href={href}>{title}</a></h3>
  <Fragment set:html={body} />
</section>
```

### 5c. `src/components/changelog/ChangelogFeed.astro`

```astro
---
/**
 * ChangelogFeed — one page's releases, newest first, under a heading per
 * year. Renders inside the docs prose column; the page's table of contents
 * lists the same years and releases.
 */
import { render } from "astro:content";
import { components } from "@/components";
import ChangelogEntry from "./ChangelogEntry.astro";
import type { ChangelogPageData } from "./release";

interface Props {
  years: ChangelogPageData["years"];
}

const years = await Promise.all(
  Astro.props.years.map(async (group) => ({
    ...group,
    releases: await Promise.all(
      group.releases.map(async (release) => ({ ...release, Content: (await render(release.entry)).Content })),
    ),
  })),
);
---

{years.map((group) => (
  <>
    <h2 id={group.anchor}>{group.year}</h2>
    {group.releases.map(({ entry, anchor, Content }) => (
      <ChangelogEntry entry={entry} anchor={anchor}>
        <Content components={components} />
      </ChangelogEntry>
    ))}
  </>
))}

<style>
  :global(.cl-release) {
    margin-top: 2rem;
    padding-bottom: 2.5rem;
    border-bottom: 1px solid var(--nb-border);
  }
  :global(.cl-release:last-child) {
    border-bottom: 0;
  }
  :global(.docs-content .cl-meta) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.625rem;
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.25rem;
    color: var(--nb-muted-foreground);
  }
  :global(.cl-meta > * + *::before) {
    content: "·";
    margin-inline-end: 0.625rem;
    color: var(--nb-border-strong);
  }
  :global(.cl-version) {
    font-family: var(--nb-font-mono);
    font-weight: 500;
    color: var(--nb-foreground);
  }
  /* The release is one prose block: the docs rhythm, scoped inside it. */
  :global(.cl-release > * + *) {
    margin-top: 1.25rem;
  }
  :global(.cl-release > h3) {
    margin-top: 0.375rem;
    /* Land with the meta line above it in view. */
    scroll-margin-top: 6.5rem;
  }
  :global(.cl-release > h3 + *) {
    margin-top: 0.75rem;
  }
  :global(.cl-release > h3 a) {
    color: inherit;
    font-weight: inherit;
    text-decoration: none;
  }
  :global(.cl-release > h3 a:hover) {
    text-decoration: underline;
    text-underline-offset: 4px;
    text-decoration-thickness: 1px;
  }
</style>
```

### 5d. `src/components/changelog/ChangelogPage.astro`

**RSS only:** without RSS, delete the `head={...}` line, the `rss` constant
and the `config` import.

```astro
---
/**
 * ChangelogPage — one page of the changelog: up to `PAGE_SIZE` releases,
 * newest first. "On this page" lists its years and releases, "More releases"
 * the range every other page holds, and the pagination bar moves to newer
 * and older releases.
 */
import { config } from "virtual:nimbus/config";
import DocsLayout from "@/layouts/DocsLayout.astro";
import ChangelogFeed from "./ChangelogFeed.astro";
import { Pagination } from "@/components/ui/pagination";
import { TOC } from "@/components/ui/toc";
import { CHANGELOG_DESCRIPTION, CHANGELOG_TITLE, releaseLabel, type ChangelogPageData } from "./release";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import type { TOCItem } from "@cloudflare/nimbus-docs/types";

interface Props {
  data: ChangelogPageData;
}

const { data } = Astro.props;
const { page } = data;
const headings: TOCItem[] = data.years.flatMap((group) => [
  { depth: 2, text: String(group.year), slug: group.anchor },
  ...group.releases.map(({ entry, anchor }) => ({ depth: 3, text: releaseLabel(entry), slug: anchor })),
]);
const prevNext = {
  prev: data.newer && { label: data.newer.range, href: data.newer.href },
  next: data.older && { label: data.older.range, href: data.older.href },
};
const rss = withBase("/changelog/rss.xml", import.meta.env.BASE_URL);
---

<DocsLayout
  title={page === 1 ? CHANGELOG_TITLE : `${CHANGELOG_TITLE}, page ${page}`}
  description={page === 1 ? CHANGELOG_DESCRIPTION : `Releases ${data.range}.`}
  sidebar={false}
  headings={headings}
  prevNext={prevNext}
  breadcrumbs={page === 1 ? [] : [{ label: CHANGELOG_TITLE, href: "/changelog/" }, { label: `Page ${page}` }]}
  socialImage="/og/changelog.png"
  head={[{ tag: "link", attrs: { rel: "alternate", type: "application/rss+xml", title: `${config.title} ${CHANGELOG_TITLE}`, href: rss } }]}
>
  <ChangelogFeed years={data.years} />
  <Fragment slot="toc">
    <TOC headings={headings} />
    {data.others.length > 0 && (
      <nav aria-label="Other changelog pages" class="cl-pages">
        <h2>More releases</h2>
        <ul>
          {data.others.map((other) =>
            other ? (
              <li><a href={withBase(other.href, import.meta.env.BASE_URL)}>{other.range}</a></li>
            ) : (
              <li aria-hidden="true" class="cl-gap">…</li>
            ),
          )}
        </ul>
      </nav>
    )}
  </Fragment>
  <Pagination slot="pagination" prevNext={prevNext} prevLabel="Newer" nextLabel="Older" />
</DocsLayout>

<style>
  .cl-pages { margin-top: 2rem; }
  .cl-pages h2 { margin: 0 0 0.5rem; font-size: 0.875rem; line-height: 1.25rem; font-weight: 600; color: var(--nb-foreground); }
  .cl-pages ul { margin: 0; padding: 0; list-style: none; }
  .cl-pages a,
  .cl-gap {
    display: block;
    padding: 0.375rem 0;
    font-size: 0.8125rem;
    line-height: 1.25rem;
    color: var(--nb-muted-foreground);
    text-decoration: none;
    font-variant-numeric: tabular-nums;
  }
  .cl-pages a:hover { color: var(--nb-foreground); }
</style>
```

### 5e. `src/pages/changelog/index.astro`

```astro
---
/** /changelog/ — the newest releases. Older ones are on /changelog/page/<n>/. */
import ChangelogPage from "@/components/changelog/ChangelogPage.astro";
import { changelogPage, getReleaseIndex } from "@/components/changelog/release";

export const prerender = true;

const data = changelogPage(await getReleaseIndex(), 1);
---

<ChangelogPage data={data} />
```

### 5f. `src/pages/changelog/page/[page].astro`

Pages 2 and up. Any other number, `/changelog/page/1/` included, is a 404.

```astro
---
/** /changelog/page/<n>/ — older releases, `PAGE_SIZE` to a page. Page 1 is /changelog/. */
import type { GetStaticPaths } from "astro";
import ChangelogPage from "@/components/changelog/ChangelogPage.astro";
import { changelogPage, getReleaseIndex, type ChangelogPageData } from "@/components/changelog/release";

export const prerender = true;
export const getStaticPaths = (async () => {
  const index = await getReleaseIndex();
  return index.pages.slice(1).map((_, i) => ({
    params: { page: String(i + 2) },
    props: { data: changelogPage(index, i + 2) },
  }));
}) satisfies GetStaticPaths;

interface Props {
  data: ChangelogPageData;
}

const { data } = Astro.props;
---

<ChangelogPage data={data} />
```

### 5g. `src/pages/changelog/[...slug].astro`

One release on its own page. `getStaticPaths` leaves out the collection's
index entry, so `/changelog/` stays the list page.

```astro
---
/** One release on its own page, in the docs layout. */
import type { GetStaticPaths } from "astro";
import DocsLayout from "@/layouts/DocsLayout.astro";
import { getCollectionStaticPaths, getCollectionPage } from "@cloudflare/nimbus-docs/runtime";
import { components } from "@/components";
import { CHANGELOG_TITLE, dateLabel, getReleaseIndex, releaseHref, releaseLabel, releaseNeighbours, type Release } from "@/components/changelog/release";
import { Pagination } from "@/components/ui/pagination";

export const getStaticPaths: GetStaticPaths = async (options) =>
  (await getCollectionStaticPaths("changelog")(options)).filter(
    (path) => path.params.slug,
  );

const page = await getCollectionPage(Astro, "changelog");
if (page instanceof Response) return page;
const { entry, Content, headings, markdownUrl, ogImageUrl } = page;
const { title, description, date, version, tags } = entry.data;
const socialImage = entry.data.socialImage ?? ogImageUrl;
// Newer and older releases, so a release page walks the changelog like a docs page walks its section.
const { newer, older } = releaseNeighbours(await getReleaseIndex(), entry.id);
const link = (release: Release | undefined) => release && { label: `${releaseLabel(release)}: ${release.data.title}`, href: releaseHref(release) };
const prevNext = { prev: link(newer), next: link(older) };
---

<DocsLayout
  title={title}
  description={description}
  sidebar={false}
  headings={headings.filter((heading) => heading.depth === 2)}
  prevNext={prevNext}
  breadcrumbs={[{ label: CHANGELOG_TITLE, href: "/changelog/" }, { label: releaseLabel(entry) }]}
  markdownUrl={markdownUrl}
  socialImage={socialImage}
  noindex={entry.data.noindex}
  head={entry.data.head}
  collection={entry.collection}
  entryId={entry.id}
>
  <p class="cl-meta">
    {version && <span class="cl-version">{version}</span>}
    <time datetime={date.toISOString().slice(0, 10)}>{dateLabel(date, "long")}</time>
    {tags.length > 0 && <span>{tags.join(", ")}</span>}
  </p>
  <Content components={components} />
  <Pagination slot="pagination" prevNext={prevNext} prevLabel="Newer" nextLabel="Older" />
</DocsLayout>

<style>
  .cl-meta { display: flex; flex-wrap: wrap; gap: 0.25rem 0.625rem; margin: 0; font-size: 0.8125rem; color: var(--nb-muted-foreground); }
  .cl-meta > * + *::before { content: "·"; margin-inline-end: 0.625rem; color: var(--nb-border-strong); }
  .cl-version { font-family: var(--nb-font-mono); font-weight: 500; color: var(--nb-foreground); }
</style>
```

The route is written for a site built ahead of time on `output: "static"`.
Its `getStaticPaths` filters the helper's paths, so `nimbus-docs check --fix`
can't edit it: when the changelog renders on request, delete
`getStaticPaths` (and the `GetStaticPaths` and `getCollectionStaticPaths`
imports); when it's built on `output: "server"`, add
`export const prerender = true;` above it. `nimbus-docs check` names the edit.

### 5h. `src/pages/changelog/rss.xml.ts` (RSS only)

Skip this step if the user declined RSS. Each item's link is its release
page and its permalink GUID.

```ts
/** /changelog/rss.xml — the changelog's RSS feed, newest release first. */
import rss from "@astrojs/rss";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";
import { CHANGELOG_TITLE, getReleaseIndex, releaseHref } from "@/components/changelog/release";

export const prerender = true;

export async function GET() {
  const url = (path: string) => new URL(withBase(path, import.meta.env.BASE_URL), config.site).href;
  const { releases } = await getReleaseIndex();
  return rss({
    title: `${config.title} ${CHANGELOG_TITLE}`,
    description: config.description ?? CHANGELOG_TITLE,
    site: url("/changelog/"),
    xmlns: { atom: "http://www.w3.org/2005/Atom" },
    customData:
      `<language>${config.locale ?? "en"}</language>` +
      `<atom:link href="${url("/changelog/rss.xml")}" rel="self" type="application/rss+xml"/>`,
    items: releases.map((entry) => ({
      title: entry.data.title,
      link: url(releaseHref(entry)),
      pubDate: entry.data.date,
      description: entry.data.description,
      categories: entry.data.tags,
    })),
  });
}
```

### 5i. `src/pages/og/changelog.png.ts`

The list pages' card. Releases get theirs from the shared `og/[...slug].ts`
route. Use the title from step 2.

With `src/pages/og/_card.ts`:

```ts
import { renderPageCard } from "./_card";

export const prerender = true;

export async function GET() {
  return new Response(await renderPageCard({ title: "Changelog" }), {
    headers: { "Content-Type": "image/png" },
  });
}
```

With `src/pages/og/_og-card-config.ts` (older starters), keep the project's
astro-og-canvas setup:

```ts
import { fileURLToPath } from "node:url";

import { publicDir, root } from "astro:config/server";
import { generateOpenGraphImage } from "astro-og-canvas";
import { ogCardConfig } from "./_og-card-config";

export const prerender = true;

export async function GET() {
  const body = await generateOpenGraphImage({
    title: "Changelog",
    description: "New features, improvements and fixes, by release.",
    ...ogCardConfig,
    fonts: [fileURLToPath(new URL("fonts/Inter-Bold.ttf", publicDir))],
    cacheDir: fileURLToPath(new URL("node_modules/.astro-og-canvas", root)),
  });
  return new Response(body, { headers: { "Content-Type": "image/png" } });
}
```

### 5j. Seed release: `src/content/changelog/<YYYY-MM-DD>-<slug>.md`

```md
---
title: Welcome to the changelog
description: The first entry, created by `nimbus-docs add changelog`. Replace it with your first release.
date: 2026-01-01
tags: [Announcement]
---

Each release is one file in `src/content/changelog/`, newest first on
`/changelog/`.

## New

- What shipped, one bullet per change, linking to its docs.

## Fixed

- What was broken, and what works now.
```

Use today's date. Add `version: "1.2.0"` when the product has versions: it
labels the release in lists, links and its Markdown version. Sections are
ordinary `##` headings; `## New`, `## Improved`, `## Deprecated` and
`## Fixed` are the usual ones, and none is required. Components in a body
must be registered in `src/components.ts`, as in docs.

## 6. Link to it (optional, ask first)

A changelog usually lives in the header or footer, not the docs sidebar.
If the user wants a link, ask where. For the sidebar, add
`{ label: "Changelog", link: "/changelog/" }` to `sidebar.items`. Don't
autogenerate a sidebar group from the collection: the list pages are the
navigation.

## 7. Verify

1. Run the build. It completes.
2. Run `npx @cloudflare/nimbus-docs check`. It reports nothing for the
   changelog routes.
3. In `dist` (release pages and their Markdown render on request when 4a
   set `"request"`: check those in preview instead):
   - `changelog/index.html`, and `changelog/page/2/index.html` once there
     are more than ten releases;
   - `changelog/<slug>/index.html`, `index.md` with `date` and `tags` in
     its frontmatter, and `index.mdx`;
   - `og/changelog.png`, used as `og:image` by `changelog/index.html`;
   - `changelog/llms.txt`, and `changelog` in the root `llms.txt`;
   - `changelog/rss.xml`, if RSS was chosen: valid RSS with one item per
     release.
4. In dev: `/changelog/` lists the releases under their years, "On this
   page" lists years and releases, and a release title opens its page,
   where "On this page" lists its sections and Newer / Older walk the
   changelog.

## 8. Already installed?

If `src/pages/changelog/index.astro` exists, the changelog is installed:
report that and don't overwrite anything. A site with the earlier design
(`src/layouts/ChangelogLayout.astro`, a date rail and tag filter) moves to
this one through the upgrade notes (`nimbus-docs upgrade`); keeping the
earlier design is fine.

## Notes for the agent

- There is no changelog schema in the framework: it's a
  `docsCollection({ schemaFields, markdownFields })`, and everything here is
  the user's source.
- `tags` are the user's own strings. Never hardcode a taxonomy.
- For a docs-shaped content tree with a sidebar, use
  `nimbus-docs add new-collection` instead.
