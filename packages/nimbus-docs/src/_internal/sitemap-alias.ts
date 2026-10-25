// `/sitemap.xml` next to `@astrojs/sitemap`'s `sitemap-index.xml`: the name
// most tools and people try first. A site that serves its own `/sitemap.xml`
// (a file in `public/`, a prerendered route, or an on-demand route) keeps it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";

import { relocateSitemap } from "./slice-output.js";

export const SITEMAP_INDEX_FILE = "sitemap-index.xml";
export const SITEMAP_ALIAS_FILE = "sitemap.xml";

/** Whether to copy the index to `sitemap.xml` in `outDir`. */
export function shouldCopySitemapAlias(options: {
  outDir: string;
  hasOwnSitemapRoute: boolean;
}): boolean {
  if (options.hasOwnSitemapRoute) return false;
  if (!fs.existsSync(path.join(options.outDir, SITEMAP_INDEX_FILE))) return false;
  return !fs.existsSync(path.join(options.outDir, SITEMAP_ALIAS_FILE));
}

/** A route pattern that serves `/sitemap.xml` itself: the exact path, or a
 *  dynamic root `.xml` route such as `/[name].xml` that would answer it. */
export function isSitemapRoutePattern(pattern: string): boolean {
  const trimmed = pattern.replace(/\/+$/u, "");
  return trimmed === `/${SITEMAP_ALIAS_FILE}` || /^\/\[[^/\]]+\]\.xml$/u.test(trimmed);
}

/**
 * Runs after `@astrojs/sitemap` (added right behind it), so the index
 * exists. A partial build without the root collection first moves the
 * sitemap files under its prefix, where its Worker serves them; the alias
 * then goes beside them.
 */
export function sitemapAliasIntegration(options: {
  hasOwnSitemapRoute: () => boolean;
  /** The slice's prefix (`/docs-es`), or null for a full build or a root slice. */
  slicePrefix?: () => string | null;
}): AstroIntegration {
  return {
    name: "nimbus-docs:sitemap-alias",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        let outDir = fileURLToPath(dir);
        const prefix = options.slicePrefix?.() ?? null;
        if (prefix) {
          relocateSitemap(outDir, prefix);
          outDir = path.join(outDir, ...prefix.split("/").filter(Boolean));
        }
        if (
          !shouldCopySitemapAlias({
            outDir,
            hasOwnSitemapRoute: options.hasOwnSitemapRoute(),
          })
        ) {
          return;
        }
        await fs.promises.copyFile(
          path.join(outDir, SITEMAP_INDEX_FILE),
          path.join(outDir, SITEMAP_ALIAS_FILE),
        );
      },
    },
  };
}
