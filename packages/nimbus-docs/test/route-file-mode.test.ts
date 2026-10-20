// Route files say what `rendering` gives them, in the starter's own shape.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { setRouteFileMode, type RouteFileTarget } from "../src/_internal/route-file-mode.js";

const pages = fileURLToPath(new URL("../../nimbus-starter-source/src/pages/", import.meta.url));
const starter = (file: string) => fs.readFileSync(path.join(pages, file), "utf8");
const docs = { collection: "docs", kind: "docs", moved: false } as const;

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
  const page = { collection: "sdk", kind: "collection" as const, moved: true };
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
  const page = { collection: "api", kind: "api" as const, moved: false };
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
  const page = { collection: "rest", kind: "api" as const, moved: true };
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

test("a prerender set by an expression is left for the author, never doubled", () => {
  for (const line of ["export const prerender = import.meta.env.PROD;", "export const prerender: boolean = true;"]) {
    const source = `import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\n${line}\nexport const { GET } = llmsRoute();\n`;
    const edit = setRouteFileMode("src/pages/llms.txt.ts", source, { mode: "request", output: "server" });
    if (line.includes("PROD")) {
      assert.equal(edit.status, "manual");
      if (edit.status === "manual") assert.match(edit.todo, /expression.*remove it/);
    } else {
      assert.equal(edit.status, "updated");
      if (edit.status === "updated") assert.doesNotMatch(edit.source, /prerender/);
    }
  }
});

test("a collection route names its collection in the page helper whenever it's edited", () => {
  const request = `---
import { getCollectionPage } from "@cloudflare/nimbus-docs/runtime";

const page = await getCollectionPage(Astro);
---
`;
  const page = { collection: "blog", kind: "collection", moved: false } as const;
  assert.equal(
    apply("src/pages/blog/[...slug].astro", request, { mode: "build", output: "server", page }),
    `---
import { getCollectionStaticPaths, getCollectionPage } from "@cloudflare/nimbus-docs/runtime";

export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("blog");

const page = await getCollectionPage(Astro, "blog");
---
`,
  );
});

test("API options built from local names aren't copied into getStaticPaths", () => {
  const request = `---
import { getApiRoute } from "@cloudflare/nimbus-docs/runtime";

const options = { homeChunkSize: 50 };
const result = await getApiRoute(Astro, "api", options);
---
`;
  const page = { collection: "api", kind: "api", moved: false } as const;
  const edit = setRouteFileMode("src/pages/api/[...slug].astro", request, { mode: "build", output: "static", page });
  assert.equal(edit.status, "manual");
  if (edit.status === "manual") {
    assert.doesNotMatch(edit.source, /export const getStaticPaths/);
    assert.match(edit.todo, /read `options`, which getStaticPaths can't see.*Export it \(`export const options = …`\), then run check --fix again\./s);
  }
});

test("API options from exported constants are copied into getStaticPaths, below them", () => {
  const request = `---
import { API_HOME_CHUNK_SIZE, getApiRoute } from "@cloudflare/nimbus-docs/runtime";

export const options = { homeChunkSize: API_HOME_CHUNK_SIZE };
const result = await getApiRoute(Astro, "api", options);
---
`;
  const page = { collection: "api", kind: "api", moved: false } as const;
  const built = apply("src/pages/api/[...slug].astro", request, { mode: "build", output: "static", page });
  assert.equal(
    built,
    `---
import { getApiStaticPaths, API_HOME_CHUNK_SIZE, getApiRoute } from "@cloudflare/nimbus-docs/runtime";

export const options = { homeChunkSize: API_HOME_CHUNK_SIZE };
export const getStaticPaths = getApiStaticPaths("api", options);
const result = await getApiRoute(Astro, "api", options);
---
`,
  );
  assert.equal(apply("src/pages/api/[...slug].astro", built, { mode: "request", output: "server", page }), request);
});

test("an expression prerender on a built route without getStaticPaths names both edits", () => {
  const source = '---\nexport const prerender = import.meta.env.PROD;\nconst page = await getCollectionPage(Astro, "sdk");\n---\n';
  const page = { collection: "sdk", kind: "collection", moved: false } as const;
  const edit = setRouteFileMode("src/pages/sdk/[...slug].astro", source, { mode: "build", output: "server", page });
  assert.equal(edit.status, "manual");
  if (edit.status === "manual")
    assert.match(edit.todo, /set it to `export const prerender = true;`\. Then add `export const getStaticPaths = getCollectionStaticPaths\("sdk"\);`/);
});

test("a collection name held in a constant isn't passed twice", () => {
  const request = `---
import { getCollectionPage } from "@cloudflare/nimbus-docs/runtime";

export const name = "sdk";
const page = await getCollectionPage(Astro, name);
---
`;
  const page = { collection: "sdk", kind: "collection", moved: true } as const;
  const built = apply("src/pages/kit/[...slug].astro", request, { mode: "build", output: "static", page });
  assert.match(built, /getCollectionPage\(Astro, name\);/);
  assert.match(built, /export const getStaticPaths = getCollectionStaticPaths\("sdk"\);/);
  assert.equal(apply("src/pages/kit/[...slug].astro", built, { mode: "request", output: "server", page }), request);
});

test("an API route with its name in a constant keeps its options in both helpers", () => {
  const request = `---
import { API_HOME_CHUNK_SIZE, getApiRoute } from "@cloudflare/nimbus-docs/runtime";

export const COLLECTION = "api";
const result = await getApiRoute(Astro, COLLECTION, { homeChunkSize: API_HOME_CHUNK_SIZE });
---
`;
  const page = { collection: "api", kind: "api", moved: false } as const;
  const built = apply("src/pages/api/[...slug].astro", request, { mode: "build", output: "static", page });
  assert.match(built, /export const getStaticPaths = getApiStaticPaths\("api", \{ homeChunkSize: API_HOME_CHUNK_SIZE \}\);/);
  assert.match(built, /getApiRoute\(Astro, COLLECTION, \{ homeChunkSize: API_HOME_CHUNK_SIZE \}\);/);
  assert.equal(apply("src/pages/api/[...slug].astro", built, { mode: "request", output: "server", page }), request);
});

test("page helper arguments Nimbus can't read become a manual step, not a guess", () => {
  const source = `---
import { getApiRoute } from "@cloudflare/nimbus-docs/runtime";
import { settings } from "../lib/api";

const result = await getApiRoute(Astro, settings);
---
`;
  const page = { collection: "api", kind: "api", moved: false } as const;
  const edit = setRouteFileMode("src/pages/api/[...slug].astro", source, { mode: "build", output: "static", page });
  assert.equal(edit.status, "manual");
  if (edit.status === "manual") {
    assert.match(edit.source, /getApiRoute\(Astro, settings\)/);
    assert.match(edit.todo, /aren't a collection name and options Nimbus can read/);
  }
});

test("a prerender sharing a statement with GET is left whole, with a step", () => {
  const source = 'import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nexport const prerender = true, GET = llmsRoute().GET;\n';
  const edit = setRouteFileMode("llms.txt.ts", source, { mode: "request", output: "server" });
  assert.equal(edit.status, "manual");
  if (edit.status === "manual") {
    assert.equal(edit.source, source);
    assert.match(edit.todo, /shares a statement with other exports/);
  }
});

test("a prerender sharing a line with other statements goes alone", () => {
  const source = 'import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nexport const prerender = true; export const { GET } = llmsRoute();\n';
  assert.equal(
    apply("llms.txt.ts", source, { mode: "request", output: "server" }),
    'import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nexport const { GET } = llmsRoute();\n',
  );
  const page = "---\nexport const prerender = true; const label = \"Docs\";\n---\n<h1>{label}</h1>\n";
  assert.equal(apply("index.astro", page, { mode: "request", output: "server" }), '---\nconst label = "Docs";\n---\n<h1>{label}</h1>\n');
});

test("a partial edit keeps what shares a line with prerender", () => {
  const source =
    'import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nexport const prerender = true; export const GET = markdownRoute().GET;\nexport function getStaticPaths() { return []; }\n';
  const edit = setRouteFileMode("[...slug]/index.md.ts", source, { mode: "request", output: "server" });
  assert.equal(edit.status, "manual");
  if (edit.status === "manual") {
    assert.match(edit.source, /^export const GET = markdownRoute\(\)\.GET;$/mu);
    assert.doesNotMatch(edit.source, /prerender/);
    assert.match(edit.todo, /Remove its getStaticPaths export/);
  }
});

test("a moved route keeps the getStaticPaths that names its collection when its helper's arguments can't be read", () => {
  const source = `---
import { getApiRoute, getApiStaticPaths } from "@cloudflare/nimbus-docs/runtime";
import { options } from "../../lib/api";

export const getStaticPaths = getApiStaticPaths("api", options);
const result = await getApiRoute(Astro, options);
---
`;
  const page = { collection: "api", kind: "api", moved: true } as const;
  const edit = setRouteFileMode("src/pages/reference/[...slug].astro", source, { mode: "request", output: "server", page });
  assert.equal(edit.status, "manual");
  if (edit.status === "manual") {
    assert.equal(edit.source, source);
    assert.match(edit.todo, /Pass "api" to its page helper first/);
  }
});

test("a prerender exported from a list is left for the author, not declared twice", () => {
  const source = 'import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nconst prerender = false;\nexport { prerender };\nexport const { GET } = llmsRoute();\n';
  const edit = setRouteFileMode("llms.txt.ts", source, { mode: "build", output: "server" });
  assert.equal(edit.status, "manual");
  if (edit.status === "manual") {
    assert.equal(edit.source, source);
    assert.match(edit.todo, /exports `prerender` from a list/);
  }
});

test("a wrapped factory gets the step it needs, not a fix that changes nothing", () => {
  const source = 'import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nconst route = markdownRoute();\nexport const GET = route.GET;\n';
  const edit = setRouteFileMode("[...slug]/index.md.ts", source, { mode: "build", output: "static" });
  assert.equal(edit.status, "manual");
  if (edit.status === "manual")
    assert.match(edit.todo, /export getStaticPaths from the factory that makes its GET, such as `export const getStaticPaths = route\.getStaticPaths;`/);
});

test("getStaticPaths in an export list counts in a .ts endpoint", () => {
  const source = 'import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nconst { GET, getStaticPaths } = markdownRoute();\nexport { GET, getStaticPaths };\n';
  assert.deepEqual(setRouteFileMode("[...slug]/index.md.ts", source, { mode: "build", output: "static" }), { status: "unchanged" });
});

test("API options that read globals such as Math are copied, not called hidden", () => {
  const request = `---
import { API_HOME_CHUNK_SIZE, getApiRoute } from "@cloudflare/nimbus-docs/runtime";

const result = await getApiRoute(Astro, "api", { homeChunkSize: Math.min(API_HOME_CHUNK_SIZE, 100) });
---
`;
  const page = { collection: "api", kind: "api", moved: false } as const;
  const built = apply("src/pages/api/[...slug].astro", request, { mode: "build", output: "static", page });
  assert.match(built, /export const getStaticPaths = getApiStaticPaths\("api", \{ homeChunkSize: Math\.min\(API_HOME_CHUNK_SIZE, 100\) \}\);/);
});

test("a comment quoting the prerender line is left alone; the declaration is edited", () => {
  const source =
    'import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\n// Remove export const prerender = false; when switching modes.\nexport const prerender = false;\nexport const { GET } = llmsRoute();\n';
  assert.equal(
    apply("llms.txt.ts", source, { mode: "build", output: "server" }),
    'import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nexport const prerender = true;\n\n// Remove export const prerender = false; when switching modes.\nexport const { GET } = llmsRoute();\n',
  );
});

test("dropping an unused helper import keeps an import beside it", () => {
  const source = `---
import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime"; import "../../lib/instrumentation";
import { getCollectionPage } from "@cloudflare/nimbus-docs/runtime";

export const getStaticPaths = getCollectionStaticPaths("sdk");

const page = await getCollectionPage(Astro, "sdk");
---
`;
  const page = { collection: "sdk", kind: "collection", moved: false } as const;
  assert.equal(
    apply("src/pages/sdk/[...slug].astro", source, { mode: "request", output: "server", page }),
    `---
import "../../lib/instrumentation";
import { getCollectionPage } from "@cloudflare/nimbus-docs/runtime";

const page = await getCollectionPage(Astro, "sdk");
---
`,
  );
});

test("a helper import spread over lines loses only the unused name", () => {
  const source = `---
import {
  getCollectionStaticPaths,
  getCollectionPage,
} from "@cloudflare/nimbus-docs/runtime";

export const getStaticPaths = getCollectionStaticPaths("sdk");

const page = await getCollectionPage(Astro, "sdk");
---
`;
  const page = { collection: "sdk", kind: "collection", moved: false } as const;
  assert.equal(
    apply("src/pages/sdk/[...slug].astro", source, { mode: "request", output: "server", page }),
    `---
import {
  getCollectionPage,
} from "@cloudflare/nimbus-docs/runtime";

const page = await getCollectionPage(Astro, "sdk");
---
`,
  );
});

test("dropping the only named helper beside a default import keeps the default", () => {
  for (const [imports, kept] of [
    ['import nimbus, { getDocsStaticPaths } from "@cloudflare/nimbus-docs";', 'import nimbus from "@cloudflare/nimbus-docs";'],
    ['import nimbus, {\n  getDocsStaticPaths,\n} from "@cloudflare/nimbus-docs";', 'import nimbus from "@cloudflare/nimbus-docs";'],
    ['import nimbus,{getDocsStaticPaths}from "@cloudflare/nimbus-docs";', 'import nimbus from "@cloudflare/nimbus-docs";'],
  ]) {
    const source = `---\n${imports}\n\nexport const getStaticPaths = getDocsStaticPaths;\n\nconsole.log(nimbus);\n---\n`;
    assert.equal(
      apply("src/pages/[...slug].astro", source, { mode: "request", output: "server", page: docs }),
      `---\n${kept}\n\nconsole.log(nimbus);\n---\n`,
    );
  }
});
