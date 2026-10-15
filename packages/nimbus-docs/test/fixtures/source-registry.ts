// The source entries of the registry, copied from their committed guides the
// way `apps/www/scripts/generate-registry.ts` emits them, into a temp folder.
// Tests don't depend on a generated `apps/www/public/registry`.

import { cpSync, mkdtempSync } from "node:fs";
import path from "node:path";

import { TEST_TMP } from "./temp-root.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SOURCES = path.join(ROOT, "apps/www/registry/sources");

export function sourceRegistry(): string {
  const dir = mkdtempSync(path.join(TEST_TMP, "nimbus-source-registry-"));
  cpSync(SOURCES, path.join(dir, "sources"), { recursive: true });
  return dir;
}
