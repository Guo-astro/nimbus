// The source entries of the registry, built from their committed sources the
// way `apps/www/scripts/generate-registry.ts` emits them (guides copied
// verbatim; a source with files as `components/<name>.json`), into a temp
// folder. Tests don't depend on a generated `apps/www/public/registry`.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TEST_TMP } from "./temp-root.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SOURCES = path.join(ROOT, "apps/www/registry/sources");
const STARTER_SRC = path.join(ROOT, "packages/nimbus-starter-source/src");

export function sourceRegistry(): string {
  const dir = mkdtempSync(path.join(TEST_TMP, "nimbus-source-registry-"));
  mkdirSync(path.join(dir, "components"), { recursive: true });
  cpSync(SOURCES, path.join(dir, "sources"), { recursive: true });
  const version = (JSON.parse(readFileSync(path.join(ROOT, "packages/nimbus-docs/package.json"), "utf8")) as { version: string }).version;
  for (const file of readdirSync(SOURCES).filter((f) => f.endsWith(".md"))) {
    const fm = JSON.parse(readFileSync(path.join(SOURCES, file), "utf8").match(/^---\n([\s\S]*?)\n---\n/)![1]!) as {
      name: string;
      title: string;
      description: string;
      files?: string[];
      dependencies?: string[];
    };
    if (!fm.files?.length) continue;
    writeFileSync(
      path.join(dir, "components", `${fm.name}.json`),
      `${JSON.stringify(
        {
          name: fm.name,
          type: "registry:source",
          title: fm.title,
          description: fm.description,
          version,
          dependencies: fm.dependencies ?? [],
          registryDependencies: [],
          files: [...fm.files].sort().map((p) => ({ path: p, content: readFileSync(path.join(STARTER_SRC, p), "utf8") })),
        },
        null,
        2,
      )}\n`,
    );
  }
  return dir;
}
