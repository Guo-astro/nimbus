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
