/**
 * Resolve `api.ref:` citations in authored `.md`/`.mdx` source to logical
 * (base-relative) routes. Authored-link normalization runs afterwards and owns
 * Astro's `base`, so citations get it exactly like hand-written links.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

import { hasCitation, resolveCitations, type CitationIndex } from "./citations.js";
import type { PageLoadScope } from "../page-load-scope.js";

export interface AuthoredCitationOptions {
  contentDirs: ReadonlyArray<string>;
  getCitationIndex: () => CitationIndex;
  /** Citation keys of schemas with no page (`schemaPages: false`) → schema name. */
  getUnpublishedCitations?: () => ReadonlyMap<string, string>;
  /** A file outside `contentDirs` that a page or partials collection recorded. */
  isRecorded?: (filePath: string) => boolean;
  /**
   * The page collection whose load is rendering right now, if any. `glob()`
   * and in-memory loaders render `.md` inside the load, before anything is
   * recorded, so that render is in scope whatever its file.
   */
  getLoadScope?: () => PageLoadScope | undefined;
}

function canonical(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Returns a source transform: `(source, filePath) => source` with in-scope
 * citations resolved. A malformed citation, or an unknown coordinate in a known
 * collection, throws (fails the build). A citation to an unknown collection
 * warns and renders `#`.
 */
export function createAuthoredCitationResolver(options: AuthoredCitationOptions) {
  const directories = [
    ...new Set(
      options.contentDirs.flatMap((dir) => {
        const absolute = path.resolve(dir);
        return [absolute, canonical(absolute)];
      }),
    ),
  ];
  const inScope = (filePath: string) =>
    directories.some(
      (dir) => filePath === dir || filePath.startsWith(dir + path.sep),
    );

  return (source: string, filePath: string | undefined): string => {
    if (!hasCitation(source)) return source;
    const absolute = filePath ? path.resolve(filePath) : undefined;
    const byFile =
      absolute !== undefined &&
      (inScope(absolute) || options.isRecorded?.(absolute) === true);
    const scope = byFile ? undefined : options.getLoadScope?.();
    if (!byFile && !scope) return source;

    const { code, diagnostics } = resolveCitations(source, {
      mode: "author",
      citationIndex: options.getCitationIndex(),
      unpublished: options.getUnpublishedCitations?.(),
    });
    const relative = absolute
      ? path.relative(process.cwd(), absolute)
      : `collection ${scope!.collection}`;
    const errors = diagnostics.filter((d) => d.level === "error");
    if (errors.length > 0) {
      throw new Error(
        `nimbus-docs: unresolved API citation in ${relative}:\n` +
          errors.map((e) => `  - ${e.message}`).join("\n"),
      );
    }
    for (const w of diagnostics) {
      if (w.level === "warning") {
        console.warn(`[nimbus:api:cite] ${relative}: ${w.message}`);
      }
    }
    return code;
  };
}
