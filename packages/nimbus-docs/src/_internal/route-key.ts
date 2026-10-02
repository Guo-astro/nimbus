/**
 * The one route-key shape for `nimbus/internal-link`: the integration uses it
 * to write `.nimbus/routes.json`, and the rule uses it to look up authored
 * links. They share it so the two sides can't drift.
 *
 * A key has a leading `/` and no trailing slash (except the root itself).
 * `foo/index.html` and `foo.html` become `/foo`. Every other file keeps its
 * extension (`/llms.txt`, `/welcome/index.md`, `/files/doc.pdf`).
 *
 * Keys never include or strip Astro's `base`. Output paths are base-free, and
 * the renderer prefixes `base` to every authored root-relative link, so an
 * authored `/x` already means "`/x` under base". A link that repeats the base
 * (`/docs/x` under `base: "/docs"`) renders as `/docs/docs/x`, and must not
 * match `/x`.
 */

import { toRouteKey, withoutHtmlExtension } from "./url.js";

/** Key for a path that's already decoded: an Astro page pathname or a file under the build output. */
export function routeKey(pathname: string): string {
  const rooted = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const key = withoutHtmlExtension(rooted);
  return key.length > 1 && key.endsWith("/") ? key.slice(0, -1) : key;
}

/** Key for an authored root-relative link: drops `?query` and `#hash` and percent-decodes first. */
export function linkRouteKey(url: string): string {
  return routeKey(toRouteKey(url));
}
