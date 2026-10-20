// Route files say what `rendering` gives them, in the starter's own shape.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { setRouteFileMode, type RouteFileTarget } from "../src/_internal/route-file-mode.js";
import { staticPathsFor } from "../src/_internal/route-helpers.js";

const pages = fileURLToPath(new URL("../../nimbus-starter-source/src/pages/", import.meta.url));
const starter = (file: string) => fs.readFileSync(path.join(pages, file), "utf8");
const docs = { collection: "docs", paths: "getDocsStaticPaths", moved: false };

function apply(file: string, source: string, target: RouteFileTarget): string {
  const edit = setRouteFileMode(file, source, target);
  assert.notEqual(edit.status, "manual", file);
  const next = edit.status === "updated" ? edit.source : source;
  assert.deepEqual(setRouteFileMode(file, next, target), { status: "unchanged" }, `${file} is idempotent`);
  return next;
}

for (const file of ["[...slug].astro", "[...slug]/index.md.ts", "[...slug]/index.mdx.ts", "[...section]/llms.txt.ts", "llms.txt.ts", "llms-full.txt.ts"]) {
  test(`${file} round-trips through every mode`, () => {
    const page = file.endsWith(".astro") ? docs : undefined;
    // The starter: built on `output: "static"`, with no line.
    const original = starter(file);
    assert.equal(apply(file, original, { mode: "build", output: "static", page }), original);
    for (const [mode, output] of [["request", "server"], ["build", "server"], ["request", "static"]] as const) {
      const next = apply(file, original, { mode, output, page });
      assert.equal(/export const prerender/u.test(next), (mode === "build") === (output === "server"), `${mode} on ${output}`);
      if (mode === "request") assert.doesNotMatch(next, /getStaticPaths/u);
      assert.equal(apply(file, next, { mode: "build", output: "static", page }), original, `back from ${mode} on ${output}`);
    }
  });
}

test("a request route away from its default URL names its collection in the page helper", () => {
  const built = `---
import { getCollectionStaticPaths, getCollectionPage } from "@cloudflare/nimbus-docs/runtime";

export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("sdk");

const page = await getCollectionPage<"sdk">(Astro);
---
`;
  const page = { collection: "sdk", paths: staticPathsFor("sdk", "collection"), moved: true };
  const request = apply("src/pages/products/kit/[...slug].astro", built, { mode: "request", output: "server", page });
  assert.equal(
    request,
    `---
import { getCollectionPage } from "@cloudflare/nimbus-docs/runtime";

const page = await getCollectionPage(Astro, "sdk");
---
`,
  );
  assert.equal(
    apply("src/pages/products/kit/[...slug].astro", request, { mode: "build", output: "static", page }),
    `---
import { getCollectionStaticPaths, getCollectionPage } from "@cloudflare/nimbus-docs/runtime";

export const getStaticPaths = getCollectionStaticPaths("sdk");

const page = await getCollectionPage(Astro, "sdk");
---
`,
  );
});

test("an API route keeps its home options across a mode switch", () => {
  const recipe = fs.readFileSync(
    fileURLToPath(new URL("../../../scripts/fixtures/api-reference/src/pages/api/[...slug].astro", import.meta.url)),
    "utf8",
  );
  const page = { collection: "api", paths: staticPathsFor("api", "api"), moved: false };
  const file = "src/pages/api/[...slug].astro";
  const request = apply(file, recipe, { mode: "request", output: "server", page });
  assert.doesNotMatch(request, /getStaticPaths|getApiStaticPaths/);
  assert.match(request, /getApiRoute\(Astro, "api", \{ homeChunkSize: API_HOME_CHUNK_SIZE \}\)/);
  assert.equal(apply(file, request, { mode: "build", output: "static", page }), recipe);
});

test("a moved request route names its collection before the helper's options", () => {
  const built = `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";

export const getStaticPaths = getApiStaticPaths("rest", { homeChunkSize: 50 });

const result = await getApiRoute(Astro, { homeChunkSize: 50 });
---
`;
  const page = { collection: "rest", paths: staticPathsFor("rest", "api"), moved: true };
  const file = "src/pages/reference/[...slug].astro";
  const request = apply(file, built, { mode: "request", output: "server", page });
  assert.match(request, /getApiRoute\(Astro, "rest", \{ homeChunkSize: 50 \}\)/);
  assert.match(
    apply(file, request, { mode: "build", output: "static", page }),
    /export const getStaticPaths = getApiStaticPaths\("rest", \{ homeChunkSize: 50 \}\);/,
  );
});

test("a file not in the starter's shape is left for the author", () => {
  const custom = `---
export const prerender = true;
export async function getStaticPaths() { return []; }
---
`;
  const edit = setRouteFileMode("src/pages/[...slug].astro", custom, { mode: "request", output: "server", page: docs });
  assert.equal(edit.status, "manual");
  if (edit.status !== "manual") return;
  assert.match(edit.todo, /Remove its getStaticPaths export/);
  assert.doesNotMatch(edit.source, /prerender/);

  const twice = "export const prerender = true;\nexport const prerender = false;\n";
  assert.equal(setRouteFileMode("llms.txt.ts", twice, { mode: "build", output: "static" }).status, "manual");
});
