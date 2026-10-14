/**
 * The files `nimbus-docs lint` reads beyond `src/content`: the `.mdx` files
 * of page collections whose loader reads another folder, as far as
 * `content.config.ts` shows statically, including a git source's snapshot
 * (the one the last build or dev start selected). A page collection whose
 * files can't be placed (an in-memory loader, computed options, a source
 * never resolved) is named, not guessed.
 */

import path from "node:path";

import picomatch from "picomatch";

import { walkFilesSync } from "../_internal/fs-walk.js";
import {
  parsePageCollectionFolders,
  placeStaticCollections,
} from "../_internal/parse-content-collections.js";
import { parseContentSourcePath, SOURCES_DIR } from "../_internal/source-paths.js";

export interface PageCollectionLintScope {
  /** Absolute `.mdx` paths outside `src/content`. */
  files: string[];
  /** The collection of a file outside `src/content`, or null. */
  collectionOf: (absPath: string) => string | null;
  /**
   * How a snapshot file is named in findings: `<source>: <repository path>`,
   * where its author fixes it. `undefined` for any other file.
   */
  displayPath: (absPath: string) => string | undefined;
  /** The source a file's snapshot belongs to: such a file is never written. */
  readOnlySource: (absPath: string) => string | undefined;
  /** One line per collection lint can't see. */
  notes: string[];
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function pageCollectionLintScope(
  projectRoot: string,
  snapshots: ReadonlyMap<string, { contentDir: string }> = new Map(),
): PageCollectionLintScope {
  const contentDir = path.join(projectRoot, "src", "content");
  const places = placeStaticCollections(
    parsePageCollectionFolders(projectRoot, path.join(projectRoot, "src", "content.config.ts")),
    snapshots,
  );
  const owners: Array<{ dir: string; collection: string }> = [];
  const files = new Set<string>();
  const unplaced: string[] = [];
  const markdown = new Set<string>();
  for (const [collection, place] of places) {
    if (place.kind === "unplaced") {
      unplaced.push(`${collection} (${place.reason})`);
      continue;
    }
    const patterns = typeof place.pattern === "string" ? [place.pattern] : place.pattern;
    const positive = patterns.filter((p) => !p.startsWith("!"));
    const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
    const matches = picomatch(positive, negative.length > 0 ? { ignore: negative } : {});
    // Lint reads MDX; count the Markdown pages it leaves out, so a clean
    // result doesn't hide them.
    for (const { abs, rel } of walkFilesSync(place.dir, { extensions: [".md"] })) {
      if (matches(rel)) markdown.add(abs);
    }
    if (inside(contentDir, place.dir)) continue;
    owners.push({ dir: place.dir, collection });
    for (const { abs, rel } of walkFilesSync(place.dir, { extensions: [".mdx"] })) {
      if (matches(rel)) files.add(abs);
    }
  }
  // The deepest folder wins when one collection's folder holds another's.
  owners.sort((a, b) => b.dir.length - a.dir.length);
  const sourceOf = (absPath: string) => {
    const relative = path.relative(projectRoot, absPath).split(path.sep).join("/");
    return relative.startsWith(`${SOURCES_DIR}/`) ? parseContentSourcePath(relative) : undefined;
  };
  return {
    files: [...files].sort(),
    collectionOf: (absPath) => owners.find((owner) => inside(owner.dir, absPath))?.collection ?? null,
    displayPath: (absPath) => {
      const source = sourceOf(absPath);
      return source ? `${source.name}: ${source.path}` : undefined;
    },
    readOnlySource: (absPath) => sourceOf(absPath)?.name,
    notes: [
      ...(unplaced.length ? [`not inspected: ${unplaced.join(", ")}.`] : []),
      ...(markdown.size
        ? [`${markdown.size} Markdown (.md) page${markdown.size === 1 ? "" : "s"} not linted: lint reads .mdx files.`]
        : []),
    ],
  };
}
