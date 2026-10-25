import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { markdownImageSource, markdownImageType } from "../src/_internal/markdown-images-dev.js";
import { markdownImageHash, markdownImageRegistry } from "../src/_internal/markdown-images.js";

test("dev finds a Markdown image's source by its URL, from the registry or by name", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nimbus-md-img-"));
  mkdirSync(path.join(root, "src/assets"), { recursive: true });
  mkdirSync(path.join(root, ".nimbus/sources/local/abc/docs"), { recursive: true });
  writeFileSync(path.join(root, "src/assets/status.svg"), "<svg/>");
  writeFileSync(path.join(root, ".nimbus/sources/local/abc/docs/pixel.png"), "png");

  // Rendered in another process (workerd): found by name and hash.
  const status = `/_nimbus/md/${markdownImageHash("src/assets/status.svg")}/status.svg`;
  assert.equal(markdownImageSource(root, status), path.join(root, "src/assets/status.svg"));
  const pixel = `/docs/_nimbus/md/${markdownImageHash(".nimbus/sources/local/abc/docs/pixel.png")}/pixel.png`;
  assert.equal(markdownImageSource(root, pixel), path.join(root, ".nimbus/sources/local/abc/docs/pixel.png"));

  // Rendered in this process: the registry answers.
  markdownImageRegistry().set("_nimbus/md/zz/logo.svg", "src/assets/status.svg");
  assert.equal(markdownImageSource(root, "/_nimbus/md/zz/logo.svg"), path.join(root, "src/assets/status.svg"));
  markdownImageRegistry().clear();

  assert.equal(markdownImageSource(root, "/_nimbus/md/nope/status.svg"), undefined);
  // Only images: a known path's hash reaches nothing else in the project.
  writeFileSync(path.join(root, ".env"), "SECRET=1");
  writeFileSync(path.join(root, "src/notes.md"), "private");
  assert.equal(markdownImageSource(root, `/_nimbus/md/${markdownImageHash(".env")}/.env`), undefined);
  assert.equal(markdownImageSource(root, `/_nimbus/md/${markdownImageHash("src/notes.md")}/notes.md`), undefined);
  assert.equal(markdownImageSource(root, "/_nimbus/shiki.css"), undefined);
  assert.equal(markdownImageType("a/status.SVG"), "image/svg+xml");
  writeFileSync(path.join(root, "src/assets/Photo.PNG"), "png");
  assert.equal(
    markdownImageSource(root, `/_nimbus/md/${markdownImageHash("src/assets/Photo.PNG")}/Photo.PNG`),
    path.join(root, "src/assets/Photo.PNG"),
  );
});
