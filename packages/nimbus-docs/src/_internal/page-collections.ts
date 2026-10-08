/**
 * The page-collection list: which content collections Nimbus routes, indexes,
 * and checks as pages.
 *
 * Collections made with Nimbus's helpers are pages; every other collection is
 * plain Astro data. The helpers already record which collections they loaded —
 * each commit to the prepared-markdown registry carries a role (`page`,
 * `partials`, or `api`) — and that record is the only source. Nothing here
 * parses `content.config.ts` to classify collections.
 *
 * The record exists only after content sync, so consumers that need the list
 * (agent outputs, the URL-collision check, `virtual:nimbus/config`,
 * `nimbus-docs check` via `.nimbus/page-collections.json`) read it through
 * {@link resolvePageCollections}, which waits for loads still in progress and
 * memoises per registry revision.
 */

import nodeFs from "node:fs";
import nodePath from "node:path";

import type { PreparedMarkdownSnapshot } from "./prepared-markdown-registry.js";
import {
  getPreparedMarkdownRevision,
  getPreparedMarkdownSnapshot,
  preparedMarkdownRootKey,
  waitForPreparedMarkdownTransactions,
} from "./prepared-markdown-registry.js";

export interface PageCollectionOrderInput {
  /** `versions.others` from the Nimbus config, in configured order. */
  versionsOthers?: readonly string[];
  /** `api` collection names from the Nimbus config, in configured order. */
  apiCollections?: readonly string[];
}

/**
 * Order the page collections deterministically: `docs`, then version
 * collections in `versions.others` order, then other page collections by
 * name, then API collections in `api` order. Commit order is nondeterministic
 * (loads finish in any order), so the list is never read in registry order.
 *
 * API collections come from config, not the record: their loaders commit with
 * role `api`, and a configured API collection is a page collection whether or
 * not its load has finished when the list is read.
 */
export function orderPageCollections(
  snapshot: Pick<PreparedMarkdownSnapshot, "collections">,
  input: PageCollectionOrderInput = {},
): string[] {
  const apiCollections = [...(input.apiCollections ?? [])];
  const apiSet = new Set(apiCollections);
  const pageNames = new Set(
    [...snapshot.collections]
      .filter(([name, value]) => value.role === "page" && !apiSet.has(name))
      .map(([name]) => name),
  );

  const ordered: string[] = [];
  if (pageNames.has("docs")) {
    ordered.push("docs");
    pageNames.delete("docs");
  }
  for (const version of input.versionsOthers ?? []) {
    const name = `docs-${version}`;
    if (pageNames.has(name)) {
      ordered.push(name);
      pageNames.delete(name);
    }
  }
  ordered.push(...[...pageNames].sort());
  ordered.push(...apiCollections);
  return ordered;
}

const resolvedListCache = new Map<
  string,
  { revision: number; key: string; list: string[] }
>();

function orderInputKey(input: PageCollectionOrderInput): string {
  return JSON.stringify([
    [...(input.versionsOthers ?? [])],
    [...(input.apiCollections ?? [])],
  ]);
}

/**
 * Read the ordered page-collection list from the registry record, waiting for
 * loads still in progress. Memoised on the registry's revision, so callers on
 * a hot path (the dev agent-capabilities middleware runs per request) don't
 * pay the wait when nothing changed.
 */
export async function resolvePageCollections(
  root: URL | string,
  input: PageCollectionOrderInput = {},
): Promise<string[]> {
  const key = preparedMarkdownRootKey(root);
  const inputKey = orderInputKey(input);
  while (true) {
    const cached = resolvedListCache.get(key);
    const revision = getPreparedMarkdownRevision(key);
    if (
      cached &&
      revision !== undefined &&
      cached.revision === revision &&
      cached.key === inputKey
    ) {
      return [...cached.list];
    }
    await waitForPreparedMarkdownTransactions(key);
    const snapshot = getPreparedMarkdownSnapshot(key);
    if (!snapshot) {
      // No helper has committed anything (and none is in flight): the record
      // is empty, so only configured API collections are pages.
      return orderPageCollections({ collections: new Map() }, input);
    }
    await waitForPreparedMarkdownTransactions(key);
    if (getPreparedMarkdownRevision(key) !== snapshot.revision) continue;
    const list = orderPageCollections(snapshot, input);
    resolvedListCache.set(key, {
      revision: snapshot.revision,
      key: inputKey,
      list,
    });
    return [...list];
  }
}

// ---------------------------------------------------------------------------
// `.nimbus/page-collections.json` — the build's page-collection list, written
// at `astro:build:start` for `nimbus-docs check`. A stale file is removed at
// `astro:config:setup`, so the file exists only for the last completed build.
// ---------------------------------------------------------------------------

export const PAGE_COLLECTIONS_FILE_VERSION = 1;

export interface PageCollectionsFile {
  /** The ordered page-collection list the build used. */
  collections: string[];
  /**
   * Project-relative paths of every `.mdx` file the registry recorded for a
   * page or partials collection — exactly what the build's MDX pass
   * validated, so `nimbus-docs check` validates the same set.
   */
  mdxFiles: string[];
}

export function pageCollectionsFilePath(projectRoot: string): string {
  return nodePath.join(projectRoot, ".nimbus", "page-collections.json");
}

/**
 * Read the build's page-collection list. `null` when the file is missing or
 * unreadable — callers fall back to the collections they can confirm from
 * config alone (docs, version, and API collections) and stay silent about
 * the rest.
 */
export function readPageCollectionsFile(
  projectRoot: string,
): PageCollectionsFile | null {
  try {
    const raw = nodeFs.readFileSync(pageCollectionsFilePath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      collections?: unknown;
      mdxFiles?: unknown;
    };
    if (parsed.version !== PAGE_COLLECTIONS_FILE_VERSION) return null;
    if (
      !Array.isArray(parsed.collections) ||
      parsed.collections.some((name) => typeof name !== "string")
    ) {
      return null;
    }
    const mdxFiles = Array.isArray(parsed.mdxFiles)
      ? parsed.mdxFiles.filter((file): file is string => typeof file === "string")
      : [];
    return { collections: parsed.collections as string[], mdxFiles };
  } catch {
    return null;
  }
}
