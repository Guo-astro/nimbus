// Social image measurement: files in `public/` get a size, a generated route
// or remote URL is skipped silently, and an unreadable file warns once.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { isPublicImagePath, measureSocialImages } from "../src/_internal/social-image-size.js";
import { pngBytes } from "./fixtures/png.js";

test("measureSocialImages: files in public/ are measured, others skipped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-og-"));
  try {
    const publicDir = path.join(root, "public");
    await mkdir(path.join(publicDir, "img"), { recursive: true });
    await writeFile(path.join(publicDir, "og4.png"), pngBytes(987, 555));
    await writeFile(path.join(publicDir, "img", "wide.png"), pngBytes(1600, 900));
    await writeFile(path.join(publicDir, "broken.png"), "not an image");
    const warnings: string[] = [];
    const sizes = await measureSocialImages({
      publicDir,
      paths: [
        "/og4.png",
        "/img/wide.png",
        "/og4.png", // repeated: measured once
        "/missing.png", // not in public/: a generated route, say
        "https://cdn.example/card.png",
        "//cdn.example/card.png",
        "/broken.png",
        "/../og4.png",
        undefined,
      ],
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(sizes, {
      "/og4.png": { width: 987, height: 555 },
      "/img/wide.png": { width: 1600, height: 900 },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /nimbus\/social-image-size: couldn't read the size of public\/broken\.png/);
    assert.match(warnings[0]!, /socialImageSize/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isPublicImagePath: only plain site-relative paths", () => {
  assert.equal(isPublicImagePath("/og.png"), true);
  assert.equal(isPublicImagePath("/a/b.jpg"), true);
  assert.equal(isPublicImagePath("https://x.test/a.png"), false);
  assert.equal(isPublicImagePath("//x.test/a.png"), false);
  assert.equal(isPublicImagePath("og.png"), false);
  assert.equal(isPublicImagePath("/og.png?v=2"), false);
});
