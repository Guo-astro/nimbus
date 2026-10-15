/**
 * Collection-mount conventions — one source of truth for "what URL prefix
 * does collection X serve at?".
 *
 * Shared between `index.ts` (which uses it for `getIndexedEntries`,
 * `getDocsPageProps`, etc.) and `lint/site-model.ts` (where
 * `findDuplicateRoutes` needs it to detect cross-collection URL
 * collisions). Keeping the function here prevents the duplicate-slug
 * validator from drifting out of sync with the actual routing.
 */

import type { CollectionRoutes } from "./collection-routes.js";

/** Primary collection name — mounted at the site root with no prefix. */
export const PRIMARY_COLLECTION = "docs";

export interface VersionInfo {
  /** Non-current version slugs (`docs-<slug>` collections mount at `/<slug>`). */
  others: readonly string[];
}

/** What a collection's URL depends on: the site's versions and its route files. */
export interface MountContext {
  versions: VersionInfo | null;
  /** Collections served by a route helper, by where the route file is. */
  routes: CollectionRoutes;
}

/** A context with no routes, for callers that only know the versions. */
export const NO_ROUTES: CollectionRoutes = new Map();

// Set at config setup and read by content loaders, which run in another
// module graph of the same process; keyed by Astro's `root` URL.
const CONTEXT_KEY = Symbol.for("@cloudflare/nimbus-docs/mount-context/v1");
const contextGlobal = globalThis as typeof globalThis & {
  [CONTEXT_KEY]?: Map<string, MountContext>;
};
const contexts = (contextGlobal[CONTEXT_KEY] ??= new Map());

export function setMountContext(root: URL, context: MountContext): void {
  contexts.set(root.href, context);
}

/** The project's context; versions and routes unknown (none) before setup records them. */
export function getMountContext(root: URL): MountContext {
  return contexts.get(root.href) ?? { versions: null, routes: NO_ROUTES };
}

/**
 * Resolve the URL-prefix segment for a given collection name.
 *
 *   1. Primary `docs` collection mounts at root → returns `""`.
 *   2. With `versions` configured, a `docs-<slug>` collection whose slug
 *      appears in `versions.others` mounts under `/<slug>` (the version
 *      label, not the collection id).
 *   3. A collection served by a route helper mounts at the route's folder
 *      (`src/pages/products/sdk/[...slug].astro` → `/products/sdk`).
 *   4. Any other collection (`api`, `blog`, …) mounts at `/<collection>`.
 *
 * Returned shape: empty string OR `/<segment>` with leading slash, no
 * trailing slash. Callers append `/<entryId>` or `/index.md`.
 */
export function collectionMountPrefix(
  collection: string,
  context: MountContext,
): string {
  const routed = context.routes.get(collection);
  if (routed) return routed.mount;
  const { versions } = context;
  if (collection === PRIMARY_COLLECTION) return "";
  if (versions && collection.startsWith("docs-")) {
    const slug = collection.slice("docs-".length);
    if (versions.others.includes(slug)) return `/${slug}`;
  }
  return `/${collection}`;
}

/**
 * Resolve the URL-safe label a collection is referenced by — the segment
 * that appears in URLs and section headers. For version collections this
 * is the manifest's short slug; for everything else it's the collection id.
 */
export function collectionLabel(
  collection: string,
  versions?: VersionInfo | null,
): string {
  if (collection === PRIMARY_COLLECTION) return collection;
  if (versions && collection.startsWith("docs-")) {
    const slug = collection.slice("docs-".length);
    if (versions.others.includes(slug)) return slug;
  }
  return collection;
}

/**
 * A stable key for the collections a route moved off their default URL, for
 * cache stamps; undefined when none moved, so those sites keep their caches.
 */
export function collectionUrlsKey(context: MountContext): string | undefined {
  const defaults = { versions: context.versions, routes: NO_ROUTES };
  const moved = [...context.routes]
    .filter(([name, { mount }]) => mount !== collectionMountPrefix(name, defaults))
    .map(([name, { mount }]) => [name, mount] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return moved.length === 0 ? undefined : JSON.stringify(moved);
}
