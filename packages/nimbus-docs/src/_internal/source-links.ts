/**
 * Relative links between the pages of a content-source collection, as a
 * repository writes them for GitHub (`[Options](2-options.md#signal)`),
 * become the pages' URLs on the site. A relative `.md`/`.mdx` link to a file
 * that isn't a page of the same collection (`../readme.md`) stays as written,
 * with one warning per file, since the site doesn't publish it.
 */

import fs from "node:fs";
import path from "node:path";

import { canonicalEntryUrl, entryRouteUrl } from "./astro-slug.js";
import { collectionMountPrefix, getMountContext } from "./collection-mount.js";
import { frontmatterSlug } from "./scan-version-frontmatter.js";
import { toDocumentHref } from "./url.js";

export interface SourceCollectionFolder {
  collection: string;
  /** Absolute folder the collection's glob reads. */
  folder: string;
  /** Astro's `root`, to find where the collection is served. */
  root: URL;
}

const REGISTRY_KEY = Symbol.for("@cloudflare/nimbus-docs/source-collection-folders/v1");
const shared = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, SourceCollectionFolder>;
};
// Folder → collection, for every collection that reads a content source.
const folders = (shared[REGISTRY_KEY] ??= new Map());
const warned = new Set<string>();

export function registerSourceCollectionFolder(entry: SourceCollectionFolder): void {
  folders.set(path.resolve(entry.folder), { ...entry, folder: path.resolve(entry.folder) });
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function collectionOf(file: string): SourceCollectionFolder | undefined {
  let best: SourceCollectionFolder | undefined;
  for (const entry of folders.values()) {
    if (inside(entry.folder, file) && (!best || entry.folder.length > best.folder.length)) best = entry;
  }
  return best;
}

const PAGE_EXTENSION = /\.mdx?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function pageUrl(owner: SourceCollectionFolder, target: string): string | undefined {
  if (!inside(owner.folder, target) || !PAGE_EXTENSION.test(target) || !fs.existsSync(target)) return undefined;
  const prefix = collectionMountPrefix(owner.collection, getMountContext(owner.root));
  let slug: string | undefined;
  try {
    slug = frontmatterSlug(fs.readFileSync(target, "utf8").slice(0, 4096));
  } catch {
    slug = undefined;
  }
  if (slug !== undefined) return toDocumentHref(entryRouteUrl(prefix, slug));
  const id = path.relative(owner.folder, target).split(path.sep).join("/").replace(PAGE_EXTENSION, "");
  return toDocumentHref(canonicalEntryUrl(prefix, id));
}

/**
 * Rewrite relative page links in `source` (Markdown or MDX) read from
 * `filePath`. Links inside fenced code are left alone. Returns `source`
 * unchanged for a file that no source collection reads.
 */
export function rewriteSourceLinks(source: string, filePath: string | undefined): string {
  if (!filePath || folders.size === 0) return source;
  const file = path.resolve(filePath);
  const owner = collectionOf(file);
  if (!owner) return source;
  const unresolved = new Set<string>();
  const rewrite = (raw: string): string => {
    if (!raw || SCHEME.test(raw) || raw.startsWith("/") || raw.startsWith("#") || raw.startsWith("<")) return raw;
    const match = /^([^?#]*)([?#].*)?$/.exec(raw);
    const pathname = match?.[1] ?? raw;
    const suffix = match?.[2] ?? "";
    if (!PAGE_EXTENSION.test(pathname)) return raw;
    let decoded: string;
    try {
      decoded = decodeURI(pathname);
    } catch {
      decoded = pathname;
    }
    const url = pageUrl(owner, path.resolve(path.dirname(file), decoded));
    if (!url) {
      unresolved.add(raw);
      return raw;
    }
    return `${url}${suffix.startsWith("?") ? suffix.replace(/^\?[^#]*/, "") : suffix}`;
  };

  let fence: string | null = null;
  const out = source.split("\n").map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) fence = null;
      return line;
    }
    if (fence !== null) return line;
    return line
      .replace(/(\]\()(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g, (_m, open: string, space: string, target: string, close: string) =>
        `${open}${space}${rewrite(target)}${close}`,
      )
      .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (_m, head: string, target: string) => `${head}${rewrite(target)}`)
      .replace(/(\bhref=")([^"]+)(")/g, (_m, open: string, target: string, close: string) => `${open}${rewrite(target)}${close}`);
  });
  if (unresolved.size > 0) {
    const key = `${file}\0${[...unresolved].join("\0")}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(
        `[nimbus] ${owner.collection}: ${path.basename(file)} links to ${[...unresolved].map((l) => `"${l}"`).join(", ")}, ` +
          "which isn't a page of this collection; the link stays as written.",
      );
    }
  }
  return out.join("\n");
}
