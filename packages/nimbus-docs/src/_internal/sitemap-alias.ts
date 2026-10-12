// `/sitemap.xml` next to `@astrojs/sitemap`'s `sitemap-index.xml`: the name
// most tools and people try first. A site that serves its own `/sitemap.xml`
// (a file in `public/`, a prerendered route, or an on-demand route) keeps it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";

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

/** A route pattern that serves `/sitemap.xml` itself. */
export function isSitemapRoutePattern(pattern: string): boolean {
  return pattern.replace(/\/+$/u, "") === `/${SITEMAP_ALIAS_FILE}`;
}

/** Runs after `@astrojs/sitemap` (added right behind it), so the index exists. */
export function sitemapAliasIntegration(options: {
  hasOwnSitemapRoute: () => boolean;
}): AstroIntegration {
  return {
    name: "nimbus-docs:sitemap-alias",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const outDir = fileURLToPath(dir);
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
