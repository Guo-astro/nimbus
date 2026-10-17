import type { CollectionEntry } from "astro:content";
import type { AstroComponentFactory } from "astro/runtime/server/index.js";

import type { ApiNav, ApiPageProps } from "../api/index.js";
import {
  COLLECTION_URLS_DOCS,
  PRIMARY_COLLECTION,
  routeFolder,
  type VersionInfo,
} from "./collection-mount.js";
import type { ProjectionContext } from "./projection.js";
import {
  LEGACY_VERSION_PARAM,
  selectApiVersion,
  type ApiQueryRouting,
} from "./api/resolve-versions.js";
import { entryRouteKey } from "./astro-slug.js";
import { toRouteKey } from "./url.js";

export interface PageIdentity {
  pathname: string;
  collection: string;
  locale?: string;
}

export interface ProsePage {
  kind: "prose";
  identity: PageIdentity;
  entry: CollectionEntry<string>;
  Content: AstroComponentFactory;
  headings: { depth: number; text: string; slug: string }[];
}

export interface ApiPage {
  kind: "api";
  identity: PageIdentity;
  page: ApiPageProps;
  nav: ApiNav;
  collection: string;
  version: string | null;
  coordinate: string;
}

export type PageResolution<
  P extends ProsePage | ApiPage = ProsePage | ApiPage,
> =
  | { status: "found"; page: P }
  | { status: "redirect"; location: string; permanent: boolean }
  | { status: "not-found" };

export interface PageResolutionContext {
  props: Record<string, unknown>;
  params: Record<string, string | undefined>;
  url: URL;
  /** The route's Astro pattern, without `base`: `/products/sdk/[...slug]`. */
  routePattern: string;
  projection?: ProjectionContext;
}

interface RouteResolutionDependencies {
  /** The page collection a route folder serves (`""` is the root), if any. */
  getCollectionAt(folder: string): Promise<string | undefined>;
  /** Reports a route under a folder no collection is served from. */
  warn(message: string): void;
}

interface ProseResolutionDependencies extends RouteResolutionDependencies {
  getVisibleEntry(
    collection: string,
    id: string,
    projection?: ProjectionContext,
  ): Promise<CollectionEntry<string> | null>;
  getVersions(): Promise<VersionInfo | null>;
  render(entry: CollectionEntry<string>): Promise<{
    Content: AstroComponentFactory;
    headings: { depth: number; text: string; slug: string }[];
  }>;
}

export type { ApiQueryRouting as ApiQueryVersionRouting } from "./api/resolve-versions.js";

interface ApiResolutionDependencies extends RouteResolutionDependencies {
  getApiCollections(): Promise<readonly string[]>;
  /** Query-mode routing info for a family, or `null` for path mode. */
  getApiQueryRouting?(collection: string): Promise<ApiQueryRouting | null>;
  getVisibleEntry(
    collection: string,
    id: string,
    projection?: ProjectionContext,
  ): Promise<CollectionEntry<string> | null>;
  render(
    collection: string,
    version: string | null,
    coordinate: string,
    entry?: CollectionEntry<string>,
  ): Promise<{ page: ApiPageProps; nav: ApiNav }>;
}

/** The same URL with 0.17's `api-version` renamed to `param`, or `null`. */
function legacyVersionLocation(url: URL, param: string): string | null {
  const params = url.searchParams;
  if (param === LEGACY_VERSION_PARAM || params.has(param)) return null;
  const value = params.get(LEGACY_VERSION_PARAM);
  if (value === null) return null;
  const next = new URLSearchParams();
  for (const [key, entry] of params)
    next.append(key === LEGACY_VERSION_PARAM ? param : key, entry);
  return `${url.pathname}?${next}`;
}

function normalizedPathname(url: URL): string {
  return toRouteKey(url.pathname);
}

function normalizedPageId(param: string | undefined): string {
  if (!param) return "index";
  const route = toRouteKey(`/${param}`);
  return route === "/" ? "index" : route.slice(1);
}

function mountedCollectionSegment(
  context: PageResolutionContext,
): string | null {
  const pathname = normalizedPathname(context.url);
  const pathSegments = pathname.split("/").filter(Boolean);
  const param = context.params.slug;
  if (!param) return pathSegments.at(-1) ?? null;

  const paramSegments = normalizedPageId(param).split("/");
  const suffix = pathSegments.slice(-paramSegments.length);
  if (suffix.join("/") !== paramSegments.join("/")) return null;
  return pathSegments.at(-(paramSegments.length + 1)) ?? null;
}

/**
 * The folder a request route serves: from its pattern, which is base-free and
 * exact, so nested URLs need no prefix matching. A route with a dynamic folder
 * (`/[locale]/[...slug]`) falls back to the URL segment before the page, and
 * isn't `exact`.
 */
function requestFolder(context: PageResolutionContext): { folder: string; exact: boolean } | null {
  const folder = routeFolder(context.routePattern);
  if (folder !== undefined) return { folder, exact: true };
  const segment = mountedCollectionSegment(context);
  return segment === null ? null : { folder: `/${segment}`, exact: false };
}

/** Whether a request route has no folder of its own, like the root route. */
function isRootRoute(context: PageResolutionContext): boolean {
  return !requestFolder(context)?.folder;
}

const reportedRoutes = new Set<string>();

async function requestCollection(
  context: PageResolutionContext,
  dependencies: RouteResolutionDependencies,
): Promise<string | null> {
  const route = requestFolder(context);
  if (!route) return null;
  const collection = await dependencies.getCollectionAt(route.folder);
  if (collection !== undefined) return collection;
  if (route.exact && !reportedRoutes.has(context.routePattern)) {
    reportedRoutes.add(context.routePattern);
    dependencies.warn(
      `nimbus-docs: the route ${context.routePattern} renders on request, but no page collection is served from ` +
        `${route.folder || "/"}. Page collections come from docsCollection() or withNimbusMarkdown(). To serve one here, ` +
        `call its route helper in this route's exported getStaticPaths; otherwise move the route to /<name>. ` +
        `See ${COLLECTION_URLS_DOCS}.`,
    );
  }
  return null;
}

/**
 * The collection and entry id a request names, and its `slug`: the page's
 * route within the collection, which only the entry's own URL matches.
 */
async function requestProseIdentity(
  context: PageResolutionContext,
  collection: string | undefined,
  dependencies: ProseResolutionDependencies,
): Promise<{ collection: string; id: string; slug: string } | null> {
  const slug = context.params.slug ? toRouteKey(`/${context.params.slug}`).slice(1) : "";
  const id = slug || "index";
  const versions = await dependencies.getVersions();
  const [first, ...rest] = slug ? slug.split("/") : [];
  if (
    first &&
    versions?.others.includes(first) &&
    ((!collection && isRootRoute(context)) ||
      collection === PRIMARY_COLLECTION ||
      collection === `${PRIMARY_COLLECTION}-${first}`)
  ) {
    return {
      collection: `${PRIMARY_COLLECTION}-${first}`,
      id: rest.join("/") || "index",
      slug: rest.join("/"),
    };
  }

  if (collection) return { collection, id, slug };
  const found = await requestCollection(context, dependencies);
  return found ? { collection: found, id, slug } : null;
}

export async function resolveProsePage(
  context: PageResolutionContext,
  options: { collection?: string },
  dependencies: ProseResolutionDependencies,
): Promise<PageResolution<ProsePage>> {
  const staticEntry = context.props.entry as
    CollectionEntry<string> | undefined;
  const requestIdentity = staticEntry
    ? null
    : await requestProseIdentity(context, options.collection, dependencies);
  const collection = staticEntry?.collection ?? requestIdentity?.collection;
  if (!collection || (!staticEntry && !requestIdentity)) {
    return { status: "not-found" };
  }

  const entry =
    staticEntry ??
    (await dependencies.getVisibleEntry(
      collection,
      requestIdentity!.id,
      context.projection,
    ));
  if (!entry) return { status: "not-found" };
  // `/index` and `/<folder>/index` find the landing; only its own URL serves it.
  if (requestIdentity && entryRouteKey(entry.id) !== requestIdentity.slug) return { status: "not-found" };

  const rendered = await dependencies.render(entry);
  return {
    status: "found",
    page: {
      kind: "prose",
      identity: { pathname: normalizedPathname(context.url), collection },
      entry,
      ...rendered,
    },
  };
}

export async function resolveApiPage(
  context: PageResolutionContext,
  options: { collection?: string },
  dependencies: ApiResolutionDependencies,
): Promise<PageResolution<ApiPage>> {
  const staticCollection =
    typeof context.props.collection === "string"
      ? context.props.collection
      : undefined;
  const staticCoordinate =
    typeof context.props.coordinate === "string"
      ? context.props.coordinate
      : undefined;
  const hasStaticIdentity =
    staticCollection !== undefined && staticCoordinate !== undefined;

  let collection = staticCollection ?? options.collection;
  let version =
    typeof context.props.version === "string" ? context.props.version : null;
  let coordinate = staticCoordinate;
  let entry = context.props.entry as CollectionEntry<string> | undefined;

  if (hasStaticIdentity && !entry) {
    entry =
      (await dependencies.getVisibleEntry(
        collection!,
        normalizedPageId(context.params.slug),
        context.projection,
      )) ?? undefined;
    if (!entry) return { status: "not-found" };
  } else if (!hasStaticIdentity) {
    const apiCollections = await dependencies.getApiCollections();
    collection ??= (await requestCollection(context, dependencies)) ?? undefined;
    if (!collection || !apiCollections.includes(collection)) {
      return { status: "not-found" };
    }

    const id = normalizedPageId(context.params.slug);
    if (id === "index" && context.params.slug !== undefined) {
      return { status: "not-found" };
    }

    // Query mode: resolution is `(version, slug) → entry`, and the found
    // entry must belong to the selected version. Store ids are not routes:
    // `/family/v2/foo` with no query selects the default version, looks up
    // the id "v2/foo", finds the v2 entry, sees the mismatch, and 404s.
    const queryRouting =
      (await dependencies.getApiQueryRouting?.(collection)) ?? null;
    if (queryRouting) {
      const selected = selectApiVersion(context.url.searchParams, queryRouting);
      if (selected === null) return { status: "not-found" };
      const isDefault = selected === queryRouting.defaultVersion;
      const storeId = isDefault
        ? id
        : id === "index"
          ? selected
          : `${selected}/${id}`;
      entry =
        (await dependencies.getVisibleEntry(
          collection,
          storeId,
          context.projection,
        )) ?? undefined;
      if (!entry) return { status: "not-found" };
      const entryVersion =
        typeof entry.data.version === "string" ? entry.data.version : null;
      if (entryVersion !== selected) return { status: "not-found" };
      coordinate =
        typeof entry.data.coordinate === "string"
          ? entry.data.coordinate
          : undefined;
      version = selected;
      if (!coordinate) return { status: "not-found" };
      const legacy = legacyVersionLocation(context.url, queryRouting.param);
      if (legacy)
        return { status: "redirect", location: legacy, permanent: true };
    } else {
      entry =
        (await dependencies.getVisibleEntry(
          collection,
          id,
          context.projection,
        )) ?? undefined;
      if (!entry) return { status: "not-found" };

      coordinate =
        typeof entry.data.coordinate === "string"
          ? entry.data.coordinate
          : undefined;
      version =
        typeof entry.data.version === "string" ? entry.data.version : null;
      if (!coordinate) {
        return { status: "not-found" };
      }
    }
  }

  const rendered = await dependencies.render(
    collection!,
    version,
    coordinate!,
    entry,
  );
  return {
    status: "found",
    page: {
      kind: "api",
      identity: {
        pathname: normalizedPathname(context.url),
        collection: collection!,
      },
      ...rendered,
      collection: collection!,
      version,
      coordinate: coordinate!,
    },
  };
}
