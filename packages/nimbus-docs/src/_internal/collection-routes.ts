/**
 * Where each collection is served, read from the route files that serve it.
 *
 * `findCollectionRoutes` walks `src/pages` the way Astro does and reads the
 * exported `getStaticPaths` of every route whose last dynamic segment is
 * `slug`. `decideCollectionMounts` turns what it found into one URL per
 * collection, plus the errors for sites whose routes build broken URLs today.
 * Read as text, never executed.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { collectionMountPrefix, NO_ROUTES, PRIMARY_COLLECTION, type MountContext, type VersionInfo } from "./collection-mount.js";
import type { SidebarConfigItem } from "../types.js";

const RUNTIME_MODULES = new Set(["@cloudflare/nimbus-docs", "@cloudflare/nimbus-docs/runtime"]);
const FACTORIES = new Set(["getCollectionStaticPaths", "getApiStaticPaths"]);
const DOCS_PATHS = "getDocsStaticPaths";

/** The docs section every collection-URL error links to. */
export const COLLECTION_URLS_DOCS = "https://nimbus-docs.com/writing/pages-and-routing/#collection-urls";

/** A route file found serving a collection. */
export interface FoundRoute {
  collection: string;
  /** The route's folder relative to `src/pages`: `""` or `/products/sdk`. */
  folder: string;
  /** Project-relative route file, `/`-separated. */
  file: string;
  /** The folder has a dynamic segment (`/[locale]/sdk`). */
  dynamic: boolean;
}

/** Where a collection is served. */
export interface CollectionMount {
  /** `""` (the root) or `/products/sdk`. */
  mount: string;
  /** Project-relative route file that defines it; absent for a default. */
  file?: string;
  /** Other static folders whose routes serve the collection too (kept, never linked). */
  aliases: string[];
}

export type CollectionRoutes = ReadonlyMap<string, CollectionMount>;

/** Every route in `src/pages` that serves a collection through a Nimbus helper. */
export function findCollectionRoutes(srcDir: string, projectRoot: string): FoundRoute[] {
  const pagesDir = path.join(srcDir, "pages");
  const found: FoundRoute[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".astro")) continue;
      const segments = routeSegments(path.relative(pagesDir, full));
      const last = segments.at(-1);
      if (last !== "[slug]" && last !== "[...slug]") continue;
      const folderSegments = segments.slice(0, -1);
      let source: string;
      try {
        source = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const collection = routeCollection(full, source);
      if (collection === undefined) continue;
      found.push({
        collection,
        folder: folderSegments.length ? `/${folderSegments.join("/")}` : "",
        file: path.relative(projectRoot, full).split(path.sep).join("/"),
        dynamic: folderSegments.some((segment) => segment.includes("[")),
      });
    }
  };
  walk(pagesDir);
  return found;
}

/**
 * A route file's path as URL segments: `products/sdk/[...slug].astro` and
 * `products/sdk/[...slug]/index.astro` are both `products, sdk, [...slug]`.
 */
export function routeSegments(relativeFile: string): string[] {
  const segments = relativeFile.split(/[\\/]/u).filter(Boolean);
  const name = segments.pop()!.replace(/\.astro$/u, "");
  if (name !== "index") segments.push(name);
  return segments;
}

/** A collection route's Astro pattern: its mount plus the file's `[slug]` or `[...slug]`. */
export function routePattern(mount: string, file: string): string {
  return `${mount}/${routeSegments(file).at(-1)}`;
}

// Array methods that keep a list of paths a list of paths.
const PATH_LIST_METHODS = new Set(["filter", "map", "flatMap", "concat", "slice", "sort", "toSorted"]);

/**
 * The collection a route's exported `getStaticPaths` serves, or undefined when
 * it serves none, or in a shape this reader doesn't follow.
 */
export function routeCollection(file: string, source: string): string | undefined {
  const code = /^\s*---\r?\n([\s\S]*?)\r?\n---/u.exec(source)?.[1];
  if (code === undefined) return undefined;
  const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  const functions = new Map<string, ts.FunctionLikeDeclaration>();
  let exported: ts.Expression | ts.FunctionLikeDeclaration | undefined;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (!RUNTIME_MODULES.has(statement.moduleSpecifier.text)) continue;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          named.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
      continue;
    }
    const isExported = ts.canHaveModifiers(statement) &&
      !!ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (isExported && statement.name.text === "getStaticPaths") exported = statement;
      else functions.set(statement.name.text, statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (isExported && declaration.name.text === "getStaticPaths") exported = declaration.initializer;
        else if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          functions.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  if (!exported) return undefined;
  // Names are followed without scopes, so a name declared again (an import
  // shadowed by a local, a wrapper by an inner one) isn't trusted, and a
  // route that relies on it isn't read.
  const declarations = new Map<string, number>();
  const declare = (node: ts.Node): void => {
    const name = (node as { name?: ts.Node }).name;
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionLike(node) || ts.isBindingElement(node) ||
        ts.isClassLike(node) || ts.isEnumDeclaration(node)) &&
      name && ts.isIdentifier(name)
    )
      declarations.set(name.text, (declarations.get(name.text) ?? 0) + 1);
    ts.forEachChild(node, declare);
  };
  for (const statement of sourceFile.statements) if (!ts.isImportDeclaration(statement)) declare(statement);
  for (const [name, count] of declarations) {
    named.delete(name);
    namespaces.delete(name);
    if (count > 1) functions.delete(name);
  }

  // The runtime export a callee or value refers to, if it's one of ours.
  const runtimeName = (node: ts.Expression): string | undefined => {
    if (ts.isIdentifier(node)) return named.get(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    )
      return node.name.text;
    return undefined;
  };
  const seen = new Set<ts.Node>();
  const fromExpression = (node: ts.Expression): string | undefined => {
    while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
      node = node.expression;
    if (runtimeName(node) === DOCS_PATHS) return PRIMARY_COLLECTION;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return fromFunction(node);
    if (!ts.isCallExpression(node)) return undefined;
    const callee = runtimeName(node.expression);
    if (callee === DOCS_PATHS) return PRIMARY_COLLECTION;
    if (callee && FACTORIES.has(callee)) {
      const [argument] = node.arguments;
      return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ? argument.text
        : undefined;
    }
    // `factory("sdk")(options)`: the helper's returned function, called.
    if (ts.isCallExpression(node.expression)) return fromExpression(node.expression);
    // `(await factory("sdk")(options)).filter(…)`: the paths, narrowed.
    if (ts.isPropertyAccessExpression(node.expression) && PATH_LIST_METHODS.has(node.expression.name.text))
      return fromExpression(node.expression.expression);
    if (ts.isIdentifier(node.expression)) {
      const local = functions.get(node.expression.text);
      if (local) return fromFunction(local);
    }
    return undefined;
  };
  const fromFunction = (fn: ts.FunctionLikeDeclaration): string | undefined => {
    if (seen.has(fn) || !fn.body) return undefined;
    seen.add(fn);
    if (!ts.isBlock(fn.body)) return fromExpression(fn.body);
    let result: string | undefined;
    const visit = (node: ts.Node): void => {
      if (result !== undefined) return;
      if (ts.isFunctionLike(node) && node !== fn) return;
      if (ts.isReturnStatement(node) && node.expression) {
        result = fromExpression(node.expression);
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return result;
  };
  return ts.isFunctionDeclaration(exported) || ts.isFunctionExpression(exported as ts.Node) || ts.isArrowFunction(exported as ts.Node)
    ? fromFunction(exported as ts.FunctionLikeDeclaration)
    : fromExpression(exported as ts.Expression);
}

export interface MountError {
  code:
    | "nimbus/collection-owns-url"
    | "nimbus/collection-dynamic-folder"
    | "nimbus/collection-docs-route"
    | "nimbus/collection-version-route"
    | "nimbus/collection-two-routes"
    | "nimbus/collection-same-url"
    | "nimbus/collection-api-root";
  /** Names the file and the fix. */
  message: string;
}

export interface MountDecision {
  mounts: Map<string, CollectionMount>;
  errors: MountError[];
}

/**
 * One URL per collection. `docs` is served at the root and a version at
 * `/<slug>`; any other collection with a helper route at the route's folder.
 * Several routes for one collection: the one at its default URL serves it and
 * the others are aliases; with none there it's an error, as is two
 * collections' routes on one URL, or a collection served only from dynamic
 * folders.
 */
export function decideCollectionMounts(
  found: readonly FoundRoute[],
  versions: VersionInfo | null,
  apiCollections: readonly string[],
): MountDecision {
  const errors: MountError[] = [];
  const byCollection = new Map<string, FoundRoute[]>();
  for (const route of found) {
    byCollection.set(route.collection, [...(byCollection.get(route.collection) ?? []), route]);
  }
  const mounts = new Map<string, CollectionMount>();
  for (const [collection, routes] of byCollection) {
    const fixed = fixedMount(collection, versions);
    const fallback = fixed ?? `/${collection}`;
    const staticRoutes = routes.filter((route) => !route.dynamic);
    if (staticRoutes.length === 0) {
      if (collection !== PRIMARY_COLLECTION)
        errors.push({
          code: "nimbus/collection-dynamic-folder",
          message:
            `${routes[0]!.file} calls the route helper for "${collection}" under a dynamic folder, and "${collection}" has no other route. ` +
            `Give each collection its own route file (src/pages${fallback}/[...slug].astro).`,
        });
      continue;
    }
    const atDefault = staticRoutes.find((route) => route.folder === fallback);
    let primary: FoundRoute;
    if (atDefault) primary = atDefault;
    else if (staticRoutes.length === 1 && fixed === undefined) primary = staticRoutes[0]!;
    else {
      errors.push(
        fixed === ""
          ? {
              code: "nimbus/collection-docs-route",
              message:
                `${staticRoutes[0]!.file} serves "docs" away from the site root, which isn't supported yet. ` +
                `Move it to src/pages/[...slug].astro, or set Astro's base to "${staticRoutes[0]!.folder}".`,
            }
          : fixed !== undefined
            ? {
                code: "nimbus/collection-version-route",
                message:
                  `docs version "${collection}" is served from ${staticRoutes[0]!.file}. Versions are served at ${fixed}; ` +
                  `move the route to src/pages${fixed}/[...slug].astro.`,
              }
            : {
                code: "nimbus/collection-two-routes",
                message:
                  `collection "${collection}" is served by ${staticRoutes.length} routes, none at ${fallback}:\n` +
                  staticRoutes.map((route) => `  ${route.file}`).join("\n") +
                  `\nKeep one; the collection is served from that folder.`,
              },
      );
      continue;
    }
    if (primary.folder === "" && fixed === undefined && apiCollections.includes(collection)) {
      errors.push({
        code: "nimbus/collection-api-root",
        message:
          `${primary.file} serves API collection "${collection}" at the site root, which isn't supported yet. ` +
          `Move the route into a folder, such as src/pages/${collection}/[...slug].astro.`,
      });
      continue;
    }
    mounts.set(collection, {
      mount: fixed ?? primary.folder,
      file: primary.file,
      aliases: staticRoutes.filter((route) => route !== primary).map((route) => route.folder),
    });
  }
  const byMount = new Map<string, string>();
  for (const [collection, { mount, file }] of mounts) {
    const other = byMount.get(mount);
    if (other !== undefined)
      errors.push({
        code: "nimbus/collection-same-url",
        message: `collections "${other}" (${mounts.get(other)!.file}) and "${collection}" (${file}) are both at ${mount || "/"}. Move one of them.`,
      });
    else byMount.set(mount, collection);
  }
  return { mounts, errors };
}

/** `docs` and version collections have URLs no route moves (yet). */
function fixedMount(collection: string, versions: VersionInfo | null): string | undefined {
  if (collection === PRIMARY_COLLECTION) return "";
  if (versions && collection.startsWith("docs-")) {
    const slug = collection.slice("docs-".length);
    if (versions.others.includes(slug)) return `/${slug}`;
  }
  return undefined;
}

/**
 * A sidebar `prefix` for a collection served by a route helper: the route
 * already sets the URL. One that matches is redundant; one that differs
 * overrides the route's URL, which a proxy in front of the site may intend.
 */
export function sidebarPrefixWarnings(
  items: readonly SidebarConfigItem[] | undefined,
  context: MountContext,
): string[] {
  const warnings: string[] = [];
  const visit = (list: readonly SidebarConfigItem[]) => {
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      if ("items" in item && Array.isArray(item.items)) visit(item.items);
      if (!("autogenerate" in item) || !("collection" in item.autogenerate)) continue;
      const { collection, prefix } = item.autogenerate;
      const routed = context.routes.get(collection);
      if (prefix === undefined || !routed?.file) continue;
      const url = routed.mount;
      warnings.push(
        prefix.replace(/\/$/u, "") === url
          ? `sidebar: \`prefix: "${prefix}"\` for collection "${collection}" repeats the URL its route sets (${routed.file}); remove it.`
          : `sidebar: \`prefix: "${prefix}"\` for collection "${collection}" overrides the URL its route sets (${url || "/"}, from ${routed.file}). ` +
              `Links in the sidebar use the prefix; remove it to link to where the pages are served.`,
      );
    }
  };
  visit(items ?? []);
  return warnings;
}

/**
 * Checks that need the page-collection list, which exists only after content
 * sync. A collection a route serves on another collection's default URL is
 * an error. A URL belongs to the deepest collection URL containing it, on
 * whole segments; another collection's page under a collection a route moved
 * is an error. At default URLs the duplicate-slug check stays the rule, and a
 * collection at the root only conflicts at the same URL.
 */
/** A request-rendered collection served away from its default URL, which request rendering can't serve yet. */
export function movedRequestRouteMessage(collection: string, file: string): string {
  return (
    `collection "${collection}" renders on request from ${file}. Request rendering serves collections only at ` +
    `/${collection} until nested URLs are supported for it. Render "${collection}" at build, or move the route to ` +
    `src/pages/${collection}/[...slug].astro.`
  );
}

export function collectionOwnershipErrors(
  entries: readonly { collection: string; url: string; source: string }[],
  pageCollections: readonly string[],
  context: MountContext,
): MountError[] {
  const errors: MountError[] = [];
  const defaultUrl = (collection: string) =>
    collectionMountPrefix(collection, { versions: context.versions, routes: NO_ROUTES });
  for (const collection of pageCollections) {
    if (context.routes.has(collection)) continue;
    const url = defaultUrl(collection);
    for (const [routed, { mount, file }] of context.routes) {
      if (routed !== collection && mount === url)
        errors.push({
          code: "nimbus/collection-same-url",
          message: `collections "${routed}" (${file}) and "${collection}" (no route, so ${url || "/"} by default) are both at ${url || "/"}. Move one of them.`,
        });
    }
  }
  const mounts = pageCollections
    .map((collection) => ({
      collection,
      mount: collectionMountPrefix(collection, context),
      moved: collectionMountPrefix(collection, context) !== defaultUrl(collection),
    }))
    .filter((entry) => entry.mount !== "")
    .sort((a, b) => b.mount.length - a.mount.length);
  const reported = new Set<string>();
  for (const entry of entries) {
    const path = entry.url.replace(/\/$/u, "") || "/";
    const owner = mounts.find(({ mount }) => path === mount || path.startsWith(`${mount}/`));
    if (!owner || !owner.moved || owner.collection === entry.collection) continue;
    const key = `${owner.collection}\0${entry.source}`;
    if (reported.has(key)) continue;
    reported.add(key);
    errors.push({
      code: "nimbus/collection-owns-url",
      message:
        `${entry.collection} page ${entry.source} is at ${path}, under ${owner.mount}, where collection "${owner.collection}" is served ` +
        `(${context.routes.get(owner.collection)?.file}). A collection's URL owns everything below it; move the page.`,
    });
  }
  return errors;
}
