// Content sources (`nimbus-docs add source <name|url>`): names and aliases
// share the slug namespace and never take a kind's name, the URL guide is not
// a name, and a source is a guide only: the agent writes any code from it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MANIFESTS } from "./manifests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = resolve(HERE, "sources");
const FEATURES = resolve(HERE, "features");
const KINDS = ["source"];

interface Frontmatter {
  name: string;
  type: string;
  aliases?: Record<string, string>;
  url?: boolean;
}

const frontmatter = (file: string): Frontmatter =>
  JSON.parse(readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n/)![1]!) as Frontmatter;

const sources = readdirSync(SOURCES)
  .filter((file) => file.endsWith(".md"))
  .map((file) => ({ file, fm: frontmatter(resolve(SOURCES, file)) }));

test("source names and aliases are unique across the registry and never a kind", () => {
  const taken = new Set([
    ...Object.keys(MANIFESTS),
    ...readdirSync(FEATURES).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)),
  ]);
  for (const kind of KINDS) assert.ok(!taken.has(kind), `a registry slug is named "${kind}"`);
  const seen = new Set<string>();
  for (const { file, fm } of sources) {
    assert.equal(fm.type, "registry:source", file);
    assert.equal(`${fm.name}.md`, file);
    if (fm.url) continue;
    for (const name of [fm.name, ...Object.keys(fm.aliases ?? {})]) {
      assert.ok(!taken.has(name) && !seen.has(name), `"${name}" is taken`);
      assert.ok(!KINDS.includes(name), `"${name}" is a kind`);
      seen.add(name);
    }
  }
  assert.deepEqual([...seen].sort(), ["bitbucket", "git", "github", "gitlab", "notion"]);
});

test("the URL guide exists and isn't a name; no source installs files", () => {
  assert.ok(sources.some(({ fm }) => fm.name === "from-url" && fm.url === true));
  for (const { file, fm } of sources) {
    for (const key of ["files", "dependencies"]) assert.ok(!(key in fm), `${file}: "${key}" — the guide carries the code`);
  }
});

test("every source guide carries the route from new-collection, word for word, and no step of another recipe", () => {
  const route = readFileSync(resolve(FEATURES, "new-collection.md"), "utf8").match(
    /### 4c\. Scaffold the page route\n\nWrite `src\/pages\/<prefix>\/\[\.\.\.slug\]\.astro`:\n\n(```astro\n[\s\S]*?\n```)\n/,
  )![1]!;
  for (const { file } of sources) {
    const body = readFileSync(resolve(SOURCES, file), "utf8");
    if (file === "from-url.md" || file === "git.md" || file === "notion.md") {
      assert.ok(body.includes(route), `${file}: the route differs from new-collection's 4c; copy it again`);
      assert.match(body, /\*\*Report to the user:\*\*/, `${file}: no report step`);
    }
    assert.doesNotMatch(body, /add new-collection --print/, `${file}: points at another recipe's steps`);
  }
});
