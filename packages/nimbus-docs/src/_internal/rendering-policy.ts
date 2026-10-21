import fs from "node:fs";
import path from "node:path";

import type { RenderingConfig, RenderingMode } from "../types.js";
import {
  collectionMountPrefix,
  NO_ROUTES,
  type MountContext,
} from "./collection-mount.js";

export interface CompiledRenderingPolicy {
  default: RenderingMode;
  collections: Readonly<Record<string, RenderingMode>>;
}

export function compileRenderingPolicy(
  rendering: RenderingConfig | undefined,
  canonicalCollections: readonly string[],
): CompiledRenderingPolicy {
  const known = new Set(canonicalCollections);
  const overrides = rendering?.collections ?? {};
  const unknown = Object.keys(overrides).filter(
    (collection) => !known.has(collection),
  );
  if (unknown.length > 0) {
    throw new Error(
      `nimbus-docs: rendering.collections references collection${unknown.length === 1 ? "" : "s"} without a registered canonical catch-all route:\n` +
        unknown.map((collection) => `  - "${collection}"`).join("\n") +
        "\n\nRegister each collection and add its canonical catch-all route before configuring its rendering mode.",
    );
  }

  const defaultMode = rendering?.default ?? "build";
  return {
    default: defaultMode,
    collections: Object.fromEntries(
      canonicalCollections.map((collection) => [
        collection,
        overrides[collection] ?? defaultMode,
      ]),
    ),
  };
}

/**
 * A collection's canonical route file: the route that serves it, else the
 * first of `[...slug].astro`, `[...slug]/index.astro`, `[slug].astro` and
 * `[slug]/index.astro` at its default URL, else `[...slug].astro` there.
 */
export function canonicalCollectionRouteComponent(
  srcDir: string,
  collection: string,
  context: MountContext,
  projectRoot: string,
): string {
  const file = context.routes.get(collection)?.file;
  if (file) return path.join(projectRoot, file);
  const folder = path.join(srcDir, "pages", collectionMountPrefix(collection, { versions: context.versions, routes: NO_ROUTES }).slice(1));
  const candidates = ["[...slug].astro", "[...slug]/index.astro", "[slug].astro", "[slug]/index.astro"].map((name) =>
    path.join(folder, name),
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

/** The route that serves a collection away from its default URL, if one does. */
export function movedCollectionRoute(
  collection: string,
  context: MountContext,
): { mount: string; file: string } | undefined {
  const routed = context.routes.get(collection);
  if (!routed?.file) return undefined;
  const fallback = collectionMountPrefix(collection, { versions: context.versions, routes: NO_ROUTES });
  return routed.mount === fallback ? undefined : { mount: routed.mount, file: routed.file };
}

export function routeComponentKeys(
  projectRoot: string,
  component: string,
): string[] {
  const absolute = normalizeRouteComponent(component);
  const relative = normalizeRouteComponent(path.relative(projectRoot, component));
  return [absolute, relative];
}

export function normalizeRouteComponent(component: string): string {
  return component
    .replace(/[?#].*$/, "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}
