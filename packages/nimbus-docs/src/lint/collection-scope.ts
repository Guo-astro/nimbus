/**
 * The files `nimbus-docs lint` reads beyond `src/content`: the `.mdx` files
 * of page collections whose loader reads another folder, as far as
 * `content.config.ts` shows statically. A page collection whose files can't
 * be placed (an in-memory loader, computed options) is named, not guessed.
 */

import path from "node:path";

import picomatch from "picomatch";

import { walkFilesSync } from "../_internal/fs-walk.js";
import { parsePageCollectionFolders } from "../_internal/parse-content-collections.js";

export interface PageCollectionLintScope {
  /** Absolute `.mdx` paths outside `src/content`. */
  files: string[];
  /** The collection of a file outside `src/content`, or null. */
  collectionOf: (absPath: string) => string | null;
  /** One line per collection lint can't see. */
  notes: string[];
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function pageCollectionLintScope(projectRoot: string): PageCollectionLintScope {
  const contentDir = path.join(projectRoot, "src", "content");
  const folders = parsePageCollectionFolders(
    projectRoot,
    path.join(projectRoot, "src", "content.config.ts"),
  );
  const owners: Array<{ dir: string; collection: string }> = [];
  const files: string[] = [];
  const unplaced: string[] = [];
  for (const [collection, place] of folders ?? []) {
    if (place.kind === "unplaced") {
      unplaced.push(collection);
      continue;
    }
    if (inside(contentDir, place.dir)) continue;
    owners.push({ dir: place.dir, collection });
    const patterns = typeof place.pattern === "string" ? [place.pattern] : place.pattern;
    const positive = patterns.filter((p) => !p.startsWith("!"));
    const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
    const matches = picomatch(positive, negative.length > 0 ? { ignore: negative } : {});
    for (const { abs, rel } of walkFilesSync(place.dir, { extensions: [".mdx"] })) {
      if (matches(rel)) files.push(abs);
    }
  }
  // The deepest folder wins when one collection's folder holds another's.
  owners.sort((a, b) => b.dir.length - a.dir.length);
  return {
    files,
    collectionOf: (absPath) => owners.find((owner) => inside(owner.dir, absPath))?.collection ?? null,
    notes: unplaced.length
      ? [
          `not inspected: ${unplaced.join(", ")} (a page collection whose loader isn't a glob over a folder ` +
            "has no files for lint to read).",
        ]
      : [],
  };
}
