// The runtime helpers a collection's page route calls. A new `*StaticPaths`
// page helper needs a row here; route-helpers.test.ts fails until it has one.

export type PageRouteKind = "docs" | "collection" | "api";

export const STATIC_PATHS_HELPERS = {
  getDocsStaticPaths: "docs",
  getCollectionStaticPaths: "collection",
  getApiStaticPaths: "api",
} as const satisfies Record<string, PageRouteKind>;

export type StaticPathsHelper = keyof typeof STATIC_PATHS_HELPERS;

// Page helpers whose second argument names the collection a route serves.
export const PAGE_HELPERS = new Set(["getCollectionPage", "getCollectionPageProps", "getApiRoute", "getApiPage"]);

export function isStaticPathsHelper(name: string | undefined): name is StaticPathsHelper {
  return name !== undefined && Object.hasOwn(STATIC_PATHS_HELPERS, name);
}

/** Whether the helper is called with the collection (`getCollectionStaticPaths("sdk")`) or used bare. */
export function takesCollection(helper: StaticPathsHelper): boolean {
  return STATIC_PATHS_HELPERS[helper] !== "docs";
}

/** The `getStaticPaths` value that builds a collection's pages. */
export function staticPathsFor(collection: string, kind: PageRouteKind): string {
  const helper = (Object.keys(STATIC_PATHS_HELPERS) as StaticPathsHelper[]).find((name) => STATIC_PATHS_HELPERS[name] === kind)!;
  return takesCollection(helper) ? `${helper}(${JSON.stringify(collection)})` : helper;
}
