/**
 * Route keys for every file a build emitted, for `.nimbus/routes.json`.
 * Astro's `pages` list misses prerendered endpoints (`/llms.txt`, feeds,
 * `.md` alternates) and `public/` files; the output directory has them all.
 *
 * Left out, because none is a link target and keeping them out keeps the
 * file small on large sites:
 *   - Astro's `build.assets` directory (default `_astro/`);
 *   - platform and config files at the output root: `_headers`,
 *     `_redirects`, `_routes.json`, `.assetsignore`, `_worker.js`;
 *   - `pagefind/`: search index fragments, thousands on a large site;
 *   - `_nimbus/`: Nimbus internals (agent-endpoint assets, `shiki.css`,
 *     the request-route inventory).
 */

import fs from "node:fs";
import path from "node:path";

import { routeKey } from "./route-key.js";

const ROOT_EXCLUDES = new Set([
  "_headers",
  "_redirects",
  "_routes.json",
  ".assetsignore",
  "_worker.js",
  "pagefind",
  "_nimbus",
]);

/**
 * Walk `outDir` (the `dir` Astro passes to `astro:build:done`) and return
 * the route key of every file in it, minus the exclusions above. Read
 * errors throw: a partial list would report real files as broken links.
 */
export function emittedFileRoutes(outDir: string, assetsDir: string): string[] {
  const assets = assetsDir.replace(/^\/+|\/+$/g, "");
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (rel === "" && ROOT_EXCLUDES.has(entry.name)) continue;
      if (assets && childRel === assets) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile()) out.push(routeKey(childRel));
    }
  };
  walk(outDir, "");
  return out;
}
