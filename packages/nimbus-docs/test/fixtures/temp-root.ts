// Temp roots for build tests live under the package, not the OS temp dir.
// A static build whose root is outside the working directory writes its
// prerender chunks to `<cwd>/.astro/.prerender`, shared by every such build;
// inside it, they go under the site's own `dist/`, so test files can run in
// parallel. `.tmp/` is gitignored; each test removes its own root, and roots a
// crashed run left behind are pruned here once they're a day old.
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const TEST_TMP = path.resolve(import.meta.dirname, "../../.tmp");
mkdirSync(TEST_TMP, { recursive: true });
for (const name of readdirSync(TEST_TMP)) {
  const dir = path.join(TEST_TMP, name);
  try {
    if (Date.now() - statSync(dir).mtimeMs > 24 * 60 * 60 * 1000) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Another test process may have removed it already.
  }
}
