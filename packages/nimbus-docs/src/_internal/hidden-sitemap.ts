// Hidden-version sitemap exclusion — @astrojs/sitemap has no version awareness,
// so the integration injects the filter this module builds. With the auto-
// noindex in NimbusHead, hidden versions stay out of search while direct links
// keep working.

import type { NimbusConfig } from "../types.js";
import { resolveAllApiCollections } from "./api/resolve-versions.js";

export function hiddenVersionPrefixes(
  config: NimbusConfig,
  base = "/",
): string[] {
  const b = base.replace(/\/$/, "");
  const out: string[] = [];
  for (const slug of config.versions?.hidden ?? []) out.push(`${b}/${slug}`);
  for (const target of resolveAllApiCollections(config.api)) {
    // A query-mode hidden version has no version-free URLs to exclude —
    // every version shares `/<family>`, so its mount prefix would remove
    // the whole visible family from the sitemap.
    if (target.hidden && target.versionMode !== "query") {
      out.push(`${b}${target.mountPath}`);
    }
  }
  return out;
}

export function makeHiddenSitemapFilter(
  config: NimbusConfig,
  base = "/",
): (url: string) => boolean {
  const prefixes = hiddenVersionPrefixes(config, base);
  return (url: string): boolean => {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url;
    }
    const p = pathname.replace(/\/$/, "") || "/";
    return !prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
  };
}
