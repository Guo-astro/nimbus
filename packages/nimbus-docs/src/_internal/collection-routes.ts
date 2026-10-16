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

/** A route file found serving a collection. */
export interface FoundRoute {
  collection: string;
  /** The route's folder relative to `src/pages`: `""` or `/products/sdk`. */
  folder: string;
  /** Project-relative route file, `/`-separated. */
  file: string;
  /** The folder has a dynamic segment (`/[locale]/sdk`). */
  dynamic: boolean;
  /** The route's last segment when it isn't `[slug]` or `[...slug]`: the helpers' params can't fill it. */
  misnamed?: string;
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

/** A static-folder route that imports a Nimbus route helper in a shape the reader doesn't follow. */
export interface UnreadRoute {
  folder: string;
  file: string;
}

export interface CollectionRouteScan {
  found: FoundRoute[];
  unread: UnreadRoute[];
}

/** Every route in `src/pages` that serves a collection through a Nimbus helper. */
export function findCollectionRoutes(srcDir: string, projectRoot: string): CollectionRouteScan {
  const pagesDir = path.join(srcDir, "pages");
  const found: FoundRoute[] = [];
  const unread: UnreadRoute[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".astro")) continue;
      const segments = routeSegments(path.relative(pagesDir, full));
      const last = segments.at(-1);
      if (!last || !/^\[(?:\.\.\.)?[^\]]+\]$/u.test(last)) continue;
      const folderSegments = segments.slice(0, -1);
      let source: string;
      try {
        source = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const { collection, usesHelper } = readRoute(source);
      const folder = folderSegments.length ? `/${folderSegments.join("/")}` : "";
      const file = path.relative(projectRoot, full).split(path.sep).join("/");
      const dynamic = folderSegments.some((segment) => segment.includes("["));
      const misnamed = last === "[slug]" || last === "[...slug]" ? undefined : last;
      if (collection !== undefined) found.push({ collection, folder, file, dynamic, ...(misnamed ? { misnamed } : {}) });
      else if (usesHelper && !dynamic && !misnamed) unread.push({ folder, file });
    }
  };
  walk(pagesDir);
  return { found, unread };
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

/** What a route file's frontmatter says about the collection it serves. */
export interface RouteRead {
  /** The collection its exported `getStaticPaths` serves, when the reader could follow it. */
  collection?: string;
  /** It imports a route helper from Nimbus, so it likely serves a collection. */
  usesHelper: boolean;
}

/**
 * The collection a route file's exported `getStaticPaths` serves. Names
 * resolve through TypeScript's checker, so scopes are real: a parameter,
 * class or inner declaration that shadows an import or wrapper is followed
 * as itself. Values are followed through `const` declarations only, and
 * top-level ones only when exported, as Astro requires.
 */
export function readRoute(source: string): RouteRead {
  const code = /^\s*---\r?\n([\s\S]*?)\r?\n---/u.exec(source)?.[1];
  if (code === undefined) return { usesHelper: false };
  // A program skips files with extensions it doesn't know, such as `.astro`.
  const name = "route.ts";
  const sourceFile = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(options),
    getSourceFile: (requested) => (requested === name ? sourceFile : undefined),
    fileExists: (requested) => requested === name,
    readFile: () => undefined,
  };
  const checker = ts.createProgram({ rootNames: [name], options, host }).getTypeChecker();

  const fromRuntime = (statement: ts.ImportDeclaration | ts.JSDocImportTag) =>
    !statement.importClause?.isTypeOnly &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    RUNTIME_MODULES.has(statement.moduleSpecifier.text);
  const declarationOf = (node: ts.Node): ts.Declaration | undefined =>
    checker.getSymbolAtLocation(node)?.declarations?.[0];
  // The runtime export a callee or value refers to, if it's one of ours.
  const runtimeName = (node: ts.Expression): string | undefined => {
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);
      return declaration && ts.isImportSpecifier(declaration) && !declaration.isTypeOnly &&
        fromRuntime(declaration.parent.parent.parent)
        ? (declaration.propertyName ?? declaration.name).text
        : undefined;
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = declarationOf(node.expression);
      return declaration && ts.isNamespaceImport(declaration) && fromRuntime(declaration.parent.parent)
        ? node.name.text
        : undefined;
    }
    return undefined;
  };
  const isConst = (declaration: ts.VariableDeclaration) =>
    ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  // Astro runs `getStaticPaths` apart from the rest of the frontmatter: a
  // top-level name it uses must be exported (imports are handled above).
  const reachable = (declaration: ts.FunctionDeclaration | ts.VariableDeclaration) => {
    const statement = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
    return statement.parent !== sourceFile || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0;
  };
  // What a declaration holds: a function, or a `const`'s value.
  const valueOf = (declaration: ts.Declaration | undefined): ts.Expression | ts.FunctionDeclaration | undefined => {
    if (!declaration || !(ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)) || !reachable(declaration))
      return undefined;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && isConst(declaration))
      return declaration.initializer;
    return undefined;
  };
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (
      ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
    )
      node = node.expression;
    return node;
  };
  const stringValue = (node: ts.Expression | undefined, depth = 0): string | undefined => {
    if (!node || depth > 8) return undefined;
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (!ts.isIdentifier(node)) return undefined;
    const value = valueOf(declarationOf(node));
    return value && !ts.isFunctionDeclaration(value) ? stringValue(value, depth + 1) : undefined;
  };

  const seen = new Set<ts.Node>();
  const fromExpression = (node: ts.Expression): string | undefined => {
    node = unwrap(node);
    if (runtimeName(node) === DOCS_PATHS) return PRIMARY_COLLECTION;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return fromFunction(node);
    if (ts.isIdentifier(node)) return fromDeclaration(declarationOf(node));
    if (!ts.isCallExpression(node)) return undefined;
    const callee = runtimeName(node.expression);
    if (callee === DOCS_PATHS) return PRIMARY_COLLECTION;
    if (callee && FACTORIES.has(callee)) return stringValue(node.arguments[0]);
    // `factory("sdk")(options)`: the helper's returned function, called.
    if (ts.isCallExpression(node.expression)) return fromExpression(node.expression);
    // `(await factory("sdk")(options)).filter(…)`: the paths, narrowed.
    if (ts.isPropertyAccessExpression(node.expression) && PATH_LIST_METHODS.has(node.expression.name.text))
      return fromExpression(node.expression.expression);
    if (ts.isIdentifier(node.expression)) return fromDeclaration(declarationOf(node.expression));
    return undefined;
  };
  const fromDeclaration = (declaration: ts.Declaration | undefined): string | undefined => {
    const value = valueOf(declaration);
    if (!value || seen.has(value)) return undefined;
    seen.add(value);
    return ts.isFunctionDeclaration(value) ? fromFunction(value) : fromExpression(value);
  };
  const fromFunction = (fn: ts.FunctionLikeDeclaration): string | undefined => {
    if (!fn.body) return undefined;
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

  const usesHelper = sourceFile.statements.some((statement) => {
    const bindings = ts.isImportDeclaration(statement) && fromRuntime(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (!bindings) return false;
    return ts.isNamespaceImport(bindings) ||
      bindings.elements.some((element) => {
        const name = (element.propertyName ?? element.name).text;
        return !element.isTypeOnly && (FACTORIES.has(name) || name === DOCS_PATHS);
      });
  });
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const exported = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === "getStaticPaths");
  // `export { getStaticPaths }` isn't followed: Astro's compiler rejects it.
  const collection = fromDeclaration(exported?.declarations?.[0]);
  return collection === undefined ? { usesHelper } : { collection, usesHelper };
}

export interface MountError {
  code:
    | "nimbus/collection-owns-url"
    | "nimbus/collection-dynamic-folder"
    | "nimbus/collection-docs-route"
    | "nimbus/collection-version-route"
    | "nimbus/collection-two-routes"
    | "nimbus/collection-same-url"
    | "nimbus/collection-api-root"
    | "nimbus/collection-route-param";
  /** Names the file and the fix. */
  message: string;
}

export interface MountWarning {
  code: "nimbus/collection-alias-route" | "nimbus/collection-unread-route";
  /** Names the file and the fix. */
  message: string;
}

export interface MountDecision {
  mounts: Map<string, CollectionMount>;
  errors: MountError[];
  /** Routes that serve a collection already served elsewhere: duplicate pages. */
  warnings: MountWarning[];
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
  const warnings: MountWarning[] = [];
  const byCollection = new Map<string, FoundRoute[]>();
  for (const route of found) {
    if (route.misnamed) {
      const fallback = fixedMount(route.collection, versions) ?? `/${route.collection}`;
      const helper = route.misnamed.startsWith("[...") ? "[...slug]" : "[slug]";
      const at = route.file.lastIndexOf(route.misnamed);
      if (route.dynamic || route.folder !== fallback)
        errors.push({
          code: "nimbus/collection-route-param",
          message:
            `${route.file} calls the route helper for "${route.collection}", but its parameter is ${route.misnamed}, which the ` +
            `helper's paths don't fill, so "${route.collection}" stays at ${fallback || "/"}. Rename it to ` +
            `${route.file.slice(0, at)}${helper}${route.file.slice(at + route.misnamed.length)}.`,
        });
      continue;
    }
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
    const mount = fixed ?? primary.folder;
    const aliases = staticRoutes.filter((route) => route !== primary);
    mounts.set(collection, { mount, file: primary.file, aliases: aliases.map((route) => route.folder) });
    for (const alias of aliases) {
      // A redirect from a folder above the mount would catch the mount too.
      const fix = mount.startsWith(`${alias.folder}/`)
        ? "delete the route"
        : `delete the route, or redirect ${alias.folder || "/"} to ${mount || "/"}`;
      warnings.push({
        code: "nimbus/collection-alias-route",
        message:
          `${alias.file} also serves collection "${collection}", which is served at ${mount || "/"} (${primary.file}). ` +
          `Its pages duplicate the collection's, in the sitemap and search too; ${fix}.`,
      });
    }
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
  return { mounts, errors, warnings };
}

/** What a dev server compares to tell whether a route file change moved a collection. */
export function mountDecisionStamp(decision: MountDecision): string {
  return JSON.stringify(
    decision.errors.length > 0
      ? { errors: decision.errors.map((error) => error.message) }
      : { mounts: [...decision.mounts] },
  );
}

/**
 * A log line for each collection whose URL differs between two route maps,
 * with the redirect to add, except from the root, where it would catch the
 * whole site, and each existing redirect (`[source, destination]`) into the
 * old URL to repoint: Astro rejects a redirect to a folder no route serves.
 */
export function collectionMoveMessages(
  before: MountContext,
  after: MountContext,
  redirects: ReadonlyArray<readonly [string, string]> = [],
): string[] {
  const collections = [...new Set([...before.routes.keys(), ...after.routes.keys()])].sort();
  return collections.flatMap((collection) => {
    const from = collectionMountPrefix(collection, before);
    const to = collectionMountPrefix(collection, after);
    if (from === to) return [];
    const moved = `collection "${collection}" moved from ${from || "/"} to ${to || "/"}.`;
    if (from === "") return [moved];
    const repoint = redirects
      .filter(([, destination]) => destination === from || destination.startsWith(`${from}/`))
      .map(([source, destination]) => ` Point "${source}" at "${to}${destination.slice(from.length)}" too.`);
    return [`${moved} Redirect its old URLs in astro.config: "${from}/[...slug]": "${to}/[...slug]".${repoint.join("")}`];
  });
}

/** `docs` and version collections have URLs no route moves (yet). */
function fixedMount(collection: string, versions: VersionInfo | null): string | undefined {
  const mount = collectionMountPrefix(collection, { versions, routes: NO_ROUTES });
  return mount === `/${collection}` ? undefined : mount;
}

/**
 * Helper routes the reader couldn't follow, in folders no collection is
 * served from by default (two or more segments). Whatever collection one
 * serves stays at its default URL, so the route builds pages nothing links
 * to, or 404s when it renders on request.
 */
export function unreadRouteWarnings(unread: readonly UnreadRoute[]): MountWarning[] {
  return unread
    .filter((route) => route.folder.split("/").length > 2)
    .map((route) => ({
      code: "nimbus/collection-unread-route",
      message:
        `Nimbus couldn't read the getStaticPaths in ${route.file}, so the collection it serves isn't served at ${route.folder}. ` +
        `Export it as \`export const getStaticPaths = getCollectionStaticPaths("<name>")\`, or return the helper's paths ` +
        `from getStaticPaths itself, passing the name as a string literal or an exported const holding one.`,
    }));
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
        `${entry.collection} page ${entry.source} is at ${path}, ${path === owner.mount ? "" : `under ${owner.mount}, `}where collection "${owner.collection}" is served ` +
        `(${context.routes.get(owner.collection)?.file}). A collection's URL owns everything below it; move the page.`,
    });
  }
  return errors;
}
