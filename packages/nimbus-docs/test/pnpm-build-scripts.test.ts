import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { declineBuildScript } from "../src/_internal/pnpm-build-scripts.js";

function decline(before: string | undefined): { changed: boolean; after: string } {
  const file = join(mkdtempSync(join(tmpdir(), "nimbus-pnpm-")), "pnpm-workspace.yaml");
  if (before !== undefined) writeFileSync(file, before);
  const changed = declineBuildScript(file, "workerd");
  return { changed, after: readFileSync(file, "utf8") };
}

test("declineBuildScript adds workerd to allowBuilds and ignoredBuiltDependencies", () => {
  assert.equal(
    decline("allowBuilds:\n  esbuild: true\nignoredBuiltDependencies:\n  - sharp\n").after,
    "allowBuilds:\n  esbuild: true\n  workerd: false\nignoredBuiltDependencies:\n  - sharp\n  - workerd\n",
  );
});

test("declineBuildScript replaces pnpm's placeholder, quoted or not", () => {
  const declined = "allowBuilds:\n  workerd: false\nignoredBuiltDependencies:\n  - workerd\n";
  assert.equal(decline("allowBuilds:\n  workerd: set this to true or false\n").after, declined);
  assert.equal(decline("allowBuilds:\n  workerd: 'set this to true or false'").after, declined);
});

test("declineBuildScript keeps a decision already made", () => {
  assert.deepEqual(decline("allowBuilds:\n  workerd: true\n"), { changed: false, after: "allowBuilds:\n  workerd: true\n" });
});

test("declineBuildScript adds allowBuilds to a file without it, or creates the file", () => {
  assert.equal(
    decline("packages:\n  - docs\nstrictDepBuilds: true\n").after,
    "packages:\n  - docs\nstrictDepBuilds: true\nallowBuilds:\n  workerd: false\nignoredBuiltDependencies:\n  - workerd\n",
  );
  assert.equal(
    decline(undefined).after,
    "packages: []\nallowBuilds: # pnpm 11\n  workerd: false\nignoredBuiltDependencies: # pnpm 10\n  - workerd\n",
  );
});

test("declineBuildScript keeps the file's YAML: flow mappings, comments, indentation", () => {
  assert.equal(
    decline("allowBuilds: { esbuild: true }\nignoredBuiltDependencies: []\n").after,
    "allowBuilds: { esbuild: true, workerd: false }\nignoredBuiltDependencies: [ workerd ]\n",
  );
  assert.equal(
    decline("# Build scripts\npackages:\n    - docs\nallowBuilds:\n    esbuild: true # needed\nignoredBuiltDependencies:\n    - esbuild\n").after,
    "# Build scripts\npackages:\n    - docs\nallowBuilds:\n    esbuild: true # needed\n    workerd: false\nignoredBuiltDependencies:\n    - esbuild\n    - workerd\n",
  );
});

test("declineBuildScript leaves a file it can't read as YAML alone", () => {
  assert.deepEqual(decline("allowBuilds: [\n"), { changed: false, after: "allowBuilds: [\n" });
  assert.deepEqual(decline("allowBuilds: true\n"), { changed: false, after: "allowBuilds: true\n" });
});

test("declineBuildScript keeps the starter's comments where they are", () => {
  const starter =
    "# Declines install scripts.\npackages: []\nallowBuilds: # pnpm 11\n  esbuild: false\nignoredBuiltDependencies: # pnpm 10\n  - esbuild\n";
  assert.equal(
    decline(starter).after,
    "# Declines install scripts.\npackages: []\nallowBuilds: # pnpm 11\n  esbuild: false\n  workerd: false\nignoredBuiltDependencies: # pnpm 10\n  - esbuild\n  - workerd\n",
  );
  // A comment above the first entry stays above it.
  assert.equal(
    decline("allowBuilds:\n  # note\n  esbuild: false\nignoredBuiltDependencies:\n  - esbuild\n").after,
    "allowBuilds:\n  # note\n  esbuild: false\n  workerd: false\nignoredBuiltDependencies:\n  - esbuild\n  - workerd\n",
  );
});
