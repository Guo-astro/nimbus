import { createHash } from "node:crypto";

import type { GeneratedMarkdownPartialResolver } from "../types.js";
import { mergePartialHeadings, type Heading } from "./partial-headings.js";
import {
  PREPARED_HEADINGS_GENERATION,
  type PreparedHeadingRecord,
} from "./prepared-headings.js";
import {
  getPreparedHeadingsRenderer,
  getPreparedMarkdownCollectionRole,
  getPreparedMarkdownEntry,
  getPreparedMarkdownRevision,
  getPreparedMarkdownSession,
  preparedMarkdownRootKey,
  waitForPreparedMarkdownTransactions,
  type PreparedMarkdownEntry,
} from "./prepared-markdown-registry.js";

export interface LazyPreparedHeadingsOptions {
  root: URL | string;
  base: string;
  partialResolver?: GeneratedMarkdownPartialResolver;
}

interface HeadingsCache {
  session: number;
  entries: Map<string, Promise<Heading[]>>;
}

const caches = new Map<string, HeadingsCache>();

function cacheFor(root: URL | string): HeadingsCache {
  const key = preparedMarkdownRootKey(root);
  const session = getPreparedMarkdownSession(root);
  let cache = caches.get(key);
  if (!cache || cache.session !== session) {
    cache = { session, entries: new Map() };
    caches.set(key, cache);
  }
  return cache;
}

/** An entry's own headings, rendered once per body. */
function ownHeadings(
  root: URL | string,
  entry: PreparedMarkdownEntry,
): Promise<Heading[]> {
  if (entry.headings) return Promise.resolve(entry.headings);
  const render = getPreparedHeadingsRenderer(root, entry.collection);
  if (!render || typeof entry.body !== "string") {
    return Promise.reject(
      new Error(
        `nimbus-docs: no headings for "${entry.collection}:${entry.id}".`,
      ),
    );
  }
  const cache = cacheFor(root);
  const key = JSON.stringify([
    entry.collection,
    entry.id,
    entry.filePath ?? "",
    createHash("sha256").update(entry.body).digest("hex"),
  ]);
  let pending = cache.entries.get(key);
  if (!pending) {
    pending = render({ body: entry.body, filePath: entry.filePath });
    cache.entries.set(key, pending);
    // A failed render must be retried, not remembered.
    pending.catch(() => {
      if (cache.entries.get(key) === pending) cache.entries.delete(key);
    });
  }
  return pending;
}

/**
 * The heading record the eager bake would produce for one page, rendered on
 * request. `null` when the entry isn't a page.
 */
export async function lazyPreparedHeadingRecord(
  options: LazyPreparedHeadingsOptions,
  collection: string,
  id: string,
): Promise<PreparedHeadingRecord | null> {
  const { root, partialResolver } = options;
  while (true) {
    await waitForPreparedMarkdownTransactions(root);
    const revision = getPreparedMarkdownRevision(root);
    if (getPreparedMarkdownCollectionRole(root, collection) !== "page") {
      return null;
    }
    const entry = getPreparedMarkdownEntry(root, collection, id);
    if (!entry || typeof entry.body !== "string") return null;
    const own = await ownHeadings(root, entry);
    const headings = /\.md$/iu.test(entry.filePath ?? "")
      ? own
      : await mergePartialHeadings(
          entry.body,
          own,
          async (partialCollection, partialId) =>
            partialCollection === "partials"
              ? getPreparedMarkdownEntry(root, "partials", partialId)
              : undefined,
          async (partial) => ({
            headings: await ownHeadings(root, partial as PreparedMarkdownEntry),
          }),
          partialResolver
            ? {
                resolvePartialId: ({ file, product }) =>
                  file ? partialResolver.resolve({ file, product }) : undefined,
              }
            : undefined,
        );
    await waitForPreparedMarkdownTransactions(root);
    if (getPreparedMarkdownRevision(root) !== revision) continue;
    return {
      collection,
      id,
      generation: PREPARED_HEADINGS_GENERATION,
      base: options.base || "/",
      headings,
    };
  }
}
