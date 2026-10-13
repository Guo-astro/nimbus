import { entryRouteUrl } from "./astro-slug.js";
import { toDocumentHref } from "./url.js";

/**
 * Site-relative URLs (no base path) for one content entry, derived from the
 * route Astro serves it at. `IndexedEntry` and the page helpers both read
 * these, so a page's links always match the files the routes emit.
 */
export interface PageUrls {
  url: string;
  markdownUrl: string;
  sourceUrl: string | undefined;
  ogImageUrl: string;
}

const OG_IMAGE_ROUTE = "/og/";

/**
 * Nimbus's generated cards, which `NimbusHead` recognises by logical path:
 * the site card at `/og.png` and one `/og/<route>.png` per page, all at
 * astro-og-canvas's default size.
 */
export const OG_CARD = {
  sitePath: "/og.png",
  pagePrefix: OG_IMAGE_ROUTE,
  size: { width: 1200, height: 630 },
} as const;

/** `ogImageUrl` is `/og/<route>.png`, with `index` for the site root. */
export function pageUrls(
  prefix: string,
  entry: { id: string; body?: unknown; filePath?: string },
): PageUrls {
  const route = entryRouteUrl(prefix, entry.id);
  const page = route === "/" ? "" : route;
  return {
    url: toDocumentHref(route),
    markdownUrl: `${page}/index.md`,
    // A frontmatter-only Markdown file has no body but still has a source.
    sourceUrl:
      (typeof entry.body === "string" && entry.body.length > 0) || /\.mdx?$/iu.test(entry.filePath ?? "")
        ? `${page}/index.mdx`
        : undefined,
    ogImageUrl: `${OG_IMAGE_ROUTE}${page.slice(1) || "index"}.png`,
  };
}

/**
 * The astro-og-canvas `pages` key whose card is written at `ogImageUrl`. The
 * key keeps `.png` because astro-og-canvas's default slug replaces a key's
 * last extension: an extensionless `v1.2/guide` would lose `.2/guide`.
 */
export function ogImagePageKey(ogImageUrl: string): string {
  return ogImageUrl.slice(OG_IMAGE_ROUTE.length);
}
