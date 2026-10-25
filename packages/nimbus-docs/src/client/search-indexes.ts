/**
 * Merge the other slices' Pagefind bundles into a loaded instance, so one
 * search covers a site built in slices (`searchIndex.merge` names them).
 *
 * A slice that holds several collections writes one bundle, so the other
 * collections' bundle URLs answer 404. Pagefind's `mergeIndex` only records
 * a bundle and fetches it on the next search, where a missing one fails the
 * whole search. So each bundle's `pagefind-entry.json` is fetched first, and
 * only the bundles that answer are merged.
 */

export interface MergeablePagefind {
  mergeIndex(indexPath: string, options?: { baseUrl?: string }): Promise<unknown>;
}

/** Merges each bundle that exists into `pagefind`; returns the merged bundles. */
export async function mergeSearchIndexes(
  pagefind: MergeablePagefind,
  bundles: readonly string[],
  options: { baseUrl?: string } = {},
): Promise<string[]> {
  const present = await Promise.all(
    bundles.map(async (bundle) => {
      const url = new URL(bundle, location.origin).href;
      try {
        const response = await fetch(new URL("pagefind-entry.json", url));
        return response.ok ? url : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const merged: string[] = [];
  for (const url of present) {
    if (!url) continue;
    try {
      await pagefind.mergeIndex(url, options);
      merged.push(url);
    } catch {
      // A bundle Pagefind can't take is skipped like a missing one.
    }
  }
  return merged;
}
