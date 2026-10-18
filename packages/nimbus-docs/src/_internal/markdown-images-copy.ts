import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { markdownImageRegistry } from "./markdown-images.js";

/** Copy every image the build's Markdown renders referenced into `outDir`. */
export function copyMarkdownImages(outDir: string, projectRoot: string): number {
  const images = markdownImageRegistry();
  let copied = 0;
  for (const [output, source] of images) {
    const from = path.resolve(projectRoot, source);
    if (!existsSync(from)) continue;
    const to = path.join(outDir, ...output.split("/"));
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
  images.clear();
  return copied;
}
