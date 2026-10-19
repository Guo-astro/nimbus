// Hidden-version sitemap exclusion — @astrojs/sitemap has no version awareness,
// so the integration injects the filter this module builds. With the auto-
// noindex in NimbusHead, hidden versions stay out of search while direct links
// keep working. The API home's later parts (`<home>/index/<n>/`) are left out
// the same way: they repeat the home's list.

import type { NimbusConfig } from "../types.js";
import { API_HOME_PART_SEGMENT } from "./api/home-index.js";
import { resolveAllApiCollections } from "./api/resolve-versions.js";
import type { MountContext } from "./collection-mount.js";

export function hiddenVersionPrefixes(
  config: NimbusConfig,
  base: string,
  context: MountContext,
): string[] {
  const b = base.replace(/\/$/, "");
  const out: string[] = [];
  for (const slug of config.versions?.hidden ?? []) out.push(`${b}/${slug}`);
  for (const target of resolveAllApiCollections(config.api, context)) {
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
  base: string,
  context: MountContext,
): (url: string) => boolean {
  const prefixes = hiddenVersionPrefixes(config, base, context);
  const b = base.replace(/\/$/, "");
  const homes = new Set(resolveAllApiCollections(config.api, context).map((target) => `${b}${target.mountPath}`.replace(/\/$/, "")));
  const homePart = new RegExp(`^(.*)/${API_HOME_PART_SEGMENT}/\\d+$`, "u");
  return (url: string): boolean => {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url;
    }
    const p = pathname.replace(/\/$/, "") || "/";
    const home = homePart.exec(p)?.[1];
    if (home !== undefined && homes.has(home)) return false;
    return !prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
  };
}
