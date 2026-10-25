import { existsSync } from "node:fs";
import path from "node:path";

import { walkFilesSync } from "./fs-walk.js";
import { MARKDOWN_IMAGE_PREFIX, markdownImageHash, markdownImageRegistry } from "./markdown-images.js";
import { SOURCES_DIR } from "./source-paths.js";

const IMAGE_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/**
 * The source file for a Markdown image URL in `astro dev`, where nothing is
 * copied (`markdown-images-copy.ts` runs at build). The registry knows it when
 * the page rendered in this process; a page rendered elsewhere (the Cloudflare
 * adapter renders in workerd) is found by name, as the image whose
 * project-relative path hashes to the URL's folder. Only image files are
 * served, so the hash can't reach anything else in the project (`.env`).
 */
export function markdownImageSource(projectRoot: string, pathname: string): string | undefined {
  const at = pathname.indexOf(`${MARKDOWN_IMAGE_PREFIX}/`);
  if (at < 0) return undefined;
  const output = pathname.slice(at);
  const [, , folder, name, ...rest] = output.split("/");
  if (!folder || !name || rest.length > 0 || !IMAGE_TYPES[path.extname(name).toLowerCase()]) return undefined;
  const recorded = markdownImageRegistry().get(output);
  if (recorded) return path.resolve(projectRoot, recorded);
  const extension = path.extname(name);
  for (const root of [projectRoot, path.join(projectRoot, SOURCES_DIR)]) {
    if (!existsSync(root)) continue;
    for (const { abs } of walkFilesSync(root, { extensions: [extension] })) {
      if (path.basename(abs) !== name) continue;
      const source = path.relative(projectRoot, abs).split(path.sep).join("/");
      if (markdownImageHash(source) === folder) return abs;
    }
  }
  return undefined;
}

export function markdownImageType(file: string): string {
  return IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
