/**
 * Partial builds: `NIMBUS_BUILD_ONLY=<collection>[,<collection>]` builds one
 * collection or a set (one locale, the API reference alone) and leaves every
 * other page collection empty, so a change to one part of a large site
 * doesn't rebuild the rest.
 *
 * The integration reads the variable once at `astro:config:setup`, and only
 * `astro build` honours it: `dev`, `sync` and `check` serve the full site.
 * The loaders ask here whether their collection is in the slice; a null
 * slice is a full build. State is keyed by project root (like the
 * prepared-markdown registry) and lives on `globalThis`, because the loaders
 * and the integration reach this module through different package entries.
 */

import { collectionMountPrefix, type VersionInfo } from "./collection-mount.js";
import { preparedMarkdownRootKey } from "./prepared-markdown-registry.js";
import { withBase } from "./url.js";

export const BUILD_ONLY_ENV = "NIMBUS_BUILD_ONLY";

const SLICE_KEY = Symbol.for("@cloudflare/nimbus-docs/build-slice/v1");
const sliceGlobal = globalThis as typeof globalThis & {
  [SLICE_KEY]?: Map<string, readonly string[] | null>;
};
const slices = (sliceGlobal[SLICE_KEY] ??= new Map());

/**
 * The collections named by the variable, in order and without repeats; null
 * when the variable is unset or blank.
 */
export function parseBuildOnly(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return null;
  return [...new Set(names)];
}

export function setBuildSlice(
  root: URL | string,
  slice: readonly string[] | null,
): void {
  slices.set(preparedMarkdownRootKey(root), slice ? [...slice] : null);
}

export function getBuildSlice(root: URL | string): readonly string[] | null {
  return slices.get(preparedMarkdownRootKey(root)) ?? null;
}

/** True in a full build, and in a slice build for a collection the slice names. */
export function isCollectionInBuildSlice(
  root: URL | string,
  collection: string,
): boolean {
  const slice = getBuildSlice(root);
  return slice === null || slice.includes(collection);
}

/**
 * The author error for a slice that can't be built, or null. Checked at
 * `astro:build:start`: page collections are a post-sync record, so a
 * mistyped name costs one content sync before failing.
 */
export function buildSliceProblem(
  slice: readonly string[],
  site: {
    /** The site's page collections, in list order. */
    pageCollections: readonly string[];
    /** The docs version collections (`docs` and every `docs-<version>`), or empty. */
    versionCollections: readonly string[];
  },
): { message: string; hint?: string } | null {
  const known = new Set(site.pageCollections);
  const unknown = slice.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return {
      message:
        `nimbus-docs: ${BUILD_ONLY_ENV} names ${unknown.map((name) => `"${name}"`).join(", ")}, ` +
        `which ${unknown.length === 1 ? "is not a page collection" : "are not page collections"}. ` +
        `Page collections in this site: ${site.pageCollections.join(", ")}.`,
      hint: `Set ${BUILD_ONLY_ENV} to one or more of those names, separated by commas.`,
    };
  }
  const inSlice = site.versionCollections.filter((name) => slice.includes(name));
  if (inSlice.length > 0 && inSlice.length < site.versionCollections.length) {
    const missing = site.versionCollections.filter((name) => !slice.includes(name));
    return {
      message:
        `nimbus-docs: ${BUILD_ONLY_ENV} holds ${inSlice.map((name) => `"${name}"`).join(", ")} ` +
        `but not ${missing.map((name) => `"${name}"`).join(", ")}. A site's docs version collections ` +
        `(${site.versionCollections.join(", ")}) build together.`,
      hint: `Add ${missing.join(", ")} to ${BUILD_ONLY_ENV}, or leave every version collection out of it.`,
    };
  }
  return null;
}

/**
 * The page collection a route key belongs to, by its longest mount prefix
 * (`""` is the root collection's and matches everything). Undefined when no
 * mount covers the key, which only happens on a site without a root
 * collection.
 */
export function routeOwner(
  key: string,
  mounts: Readonly<Record<string, string>>,
): string | undefined {
  let owner: string | undefined;
  let longest = -1;
  for (const [collection, prefix] of Object.entries(mounts)) {
    if (prefix.length <= longest) continue;
    if (prefix === "" || key === prefix || key.startsWith(`${prefix}/`)) {
      owner = collection;
      longest = prefix.length;
    }
  }
  return owner;
}

/**
 * Where a partial build writes. A slice holding the root collection is a
 * root slice and writes where a full build does. Any other slice writes its
 * site-wide artifacts (sitemap files, the Pagefind bundle,
 * `_nimbus/shiki.css`, its bundled CSS and JS) under its prefix: the mount
 * of the first collection the variable names, so a Worker on that prefix's
 * zone routes serves them. Like every Astro output path, the prefix is
 * base-free: under `base: "/docs"` the files are at `docs-es/…` in the
 * output and served at `/docs/docs-es/…`.
 */
export interface BuildSliceLayout {
  collections: readonly string[];
  /** `""` for a root slice; the leading collection's mount (`/docs-es`) otherwise. */
  prefix: string;
  root: boolean;
}

export function buildSliceLayout(
  slice: readonly string[],
  versions: VersionInfo | null,
): BuildSliceLayout {
  const mounts = slice.map((name) => collectionMountPrefix(name, versions));
  const root = mounts.includes("");
  return { collections: [...slice], prefix: root ? "" : mounts[0]!, root };
}

/**
 * The starter's root routes, which a non-root slice drops from its output:
 * the root slice serves them, and the zone never sends them to another
 * slice's Worker. Each is excluded from the slice's sitemap too.
 */
export const STARTER_ROOT_ROUTES: readonly string[] = [
  "/",
  "/robots.txt",
  "/og.png",
  "/nimbus-api/coordinates.json",
];

/**
 * The Pagefind bundle a page collection's slice serves, by its mount: the
 * root collection's at `/pagefind/`, a mounted one's under its prefix. A
 * slice of several collections writes one bundle, under its first
 * collection's prefix; the others' URLs then answer 404 and the client
 * skips them.
 */
export function pagefindBundlePath(mount: string): string {
  return `${mount}/pagefind/`;
}

/**
 * What the search client loads: this build's bundle, and the bundles of the
 * page collections outside the slice to merge into it, so one search box
 * still covers the site. A full build merges nothing. Served URLs, base
 * included, so a search provider fetches them as they are.
 */
export function searchIndexLayout(
  layout: BuildSliceLayout | null,
  pageCollections: readonly string[],
  versions: VersionInfo | null,
  base: string,
): { bundle: string; merge: string[] } {
  const served = (mount: string) => withBase(pagefindBundlePath(mount), base);
  if (!layout) return { bundle: served(""), merge: [] };
  const merge = [
    ...new Set(
      pageCollections
        .filter((name) => !layout.collections.includes(name))
        .map((name) => served(collectionMountPrefix(name, versions))),
    ),
  ];
  return { bundle: served(layout.prefix), merge };
}
