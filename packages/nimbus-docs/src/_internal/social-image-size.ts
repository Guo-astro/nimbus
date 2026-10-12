// Social image sizes, measured once at setup so `og:image:width`/`height`
// describe the image they accompany. Only files under `public/` can be
// measured: a generated route or a remote URL has no file to read.

import fs from "node:fs";
import path from "node:path";

import { imageMetadata } from "astro/assets/utils";

export interface ImageSize {
  width: number;
  height: number;
}

/** `og:image` sizes keyed by the logical image path (`/og4.png`). */
export type ImageSizes = Record<string, ImageSize>;

/** A site-relative path that could name a file under `public/`. */
export function isPublicImagePath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);

/**
 * Logical paths (`/og/hero.png`) of every image file under `public/<dir>`.
 * The generated cards live at `/og/<page>.png`, so a user's own file there
 * must be measured rather than assumed to be a card.
 */
export function listPublicImages(publicDir: string, dir: string): string[] {
  const root = path.resolve(publicDir, dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(`/${path.relative(path.resolve(publicDir), file).split(path.sep).join("/")}`);
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Width and height of an image file, or `null` when it can't be read as an image. */
export async function measureImageFile(file: string): Promise<ImageSize | null> {
  try {
    const data = await fs.promises.readFile(file);
    const { width, height } = await imageMetadata(new Uint8Array(data), file);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Measure the social images that resolve to files in `public/`. A path that
 * isn't under `public/` (a generated route, an absolute URL) is skipped
 * silently; a file that exists but can't be measured is reported once
 * through `warn`, and its tags are left out.
 */
export async function measureSocialImages(options: {
  publicDir: string;
  paths: Iterable<string | undefined>;
  warn: (message: string) => void;
}): Promise<ImageSizes> {
  const sizes: ImageSizes = {};
  const root = path.resolve(options.publicDir);
  for (const logical of new Set(options.paths)) {
    if (!logical || !isPublicImagePath(logical)) continue;
    const file = path.resolve(root, `.${logical}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) continue;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const size = await measureImageFile(file);
    if (size) {
      sizes[logical] = size;
    } else {
      options.warn(
        `nimbus/social-image-size: couldn't read the size of public${logical}, so its pages ` +
          `get no og:image:width or og:image:height. Pass socialImageSize to NimbusHead to set them.`,
      );
    }
  }
  return sizes;
}
