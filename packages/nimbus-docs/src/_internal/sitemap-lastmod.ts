// `<lastmod>` for the sitemap: each page's frontmatter `lastUpdated`, else
// the last git commit that touched its source file. Nimbus's serialize runs
// before the site's own, which can change or drop the value.

import type { SitemapItem, SitemapSerialize } from "./sitemap-types.js";
import { entryRouteUrl } from "./astro-slug.js";
import { collectionMountPrefix, type MountContext } from "./collection-mount.js";
import type { PreparedMarkdownSnapshot } from "./prepared-markdown-registry.js";
import { safeDecode, toRouteKey, withBase, withoutHtmlExtension } from "./url.js";

export interface SitemapSource {
  filePath?: string;
  lastUpdated?: Date | string;
}

/** Sitemap route key → the page's source, for every page-role entry. */
export function sitemapSources(options: {
  snapshot: PreparedMarkdownSnapshot | null | undefined;
  base: string;
  context: MountContext;
}): Map<string, SitemapSource> {
  const sources = new Map<string, SitemapSource>();
  for (const [collection, value] of options.snapshot?.collections ?? []) {
    if (value.role !== "page") continue;
    const prefix = collectionMountPrefix(collection, options.context);
    for (const entry of value.entries.values()) {
      const route = entryRouteUrl(prefix, entry.id);
      const key = toRouteKey(withBase(route, options.base));
      if (sources.has(key)) continue;
      const lastUpdated = entry.data.lastUpdated;
      sources.set(key, {
        filePath: entry.filePath?.replaceAll("\\", "/"),
        lastUpdated:
          lastUpdated instanceof Date || typeof lastUpdated === "string" ? lastUpdated : undefined,
      });
    }
  }
  return sources;
}

function isoDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The route key of a sitemap URL, decoded and without base-less noise. */
export function sitemapRouteKey(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  return toRouteKey(withoutHtmlExtension(safeDecode(pathname)));
}

/**
 * A `serialize` for `@astrojs/sitemap` that sets `lastmod` from the page's
 * source, then hands the entry to the site's own `serialize`. Lookups never
 * throw: `@astrojs/sitemap` drops the whole file on a serialize error.
 */
export function createSitemapSerialize(options: {
  sources: () => Map<string, SitemapSource>;
  dates: () => Record<string, string> | null;
  serialize?: SitemapSerialize;
}): SitemapSerialize {
  let resolved: Map<string, SitemapSource> | null = null;
  return (item) => {
    let next: SitemapItem = item;
    try {
      resolved ??= options.sources();
      const source = resolved.get(sitemapRouteKey(item.url));
      if (source) {
        const dates = options.dates();
        const lastmod =
          isoDate(source.lastUpdated) ??
          (source.filePath ? dates?.[source.filePath] : undefined);
        if (lastmod) next = { ...item, lastmod };
      }
    } catch {
      next = item;
    }
    return options.serialize ? options.serialize(next) : next;
  };
}
