/**
 * @internal
 *
 * Public-but-unstable subpath (`@cloudflare/nimbus-docs/site-parts`). It exists
 * so `@cloudflare/create-nimbus-docs` composes a site's parts with the same code
 * `outdated` and `diff` use to rebuild its starter tree. The scaffolder bundles
 * it at build time. No external stability guarantee.
 */
export {
  SITE_PARTS_DIR,
  composeSiteFiles,
  readSiteParts,
} from "./_internal/site-parts.js";
export type { SiteRecord, SitePartsComponent, SitePartsManifest } from "./_internal/site-parts.js";
