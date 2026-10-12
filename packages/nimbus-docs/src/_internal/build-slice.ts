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

import { preparedMarkdownRootKey } from "./prepared-markdown-registry.js";

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
