import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runChecks } from "../../src/check/run.js";
import { applyRouteFiles, planRouteFiles } from "../../src/_internal/route-files.js";

const STRUCTURE = { env: false, structure: true, authoring: false, types: false, migrations: false };
const starterPages = fileURLToPath(new URL("../../../nimbus-starter-source/src/pages/", import.meta.url));
const ROUTES = ["[...slug].astro", "[...slug]/index.md.ts", "[...slug]/index.mdx.ts", "[...section]/llms.txt.ts", "llms.txt.ts", "llms-full.txt.ts"];
// The starter's routes that export getStaticPaths.
const DYNAMIC = ROUTES.filter((route) => route.startsWith("[")).map((route) => `src/pages/${route}`).sort();

function project(options: { output: string; rendering?: string; files?: Record<string, string> }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-route-files-"));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write("package.json", `{ "name": "fixture" }`);
  write(
    "astro.config.ts",
    `import nimbus from "@cloudflare/nimbus-docs";
export default { output: "${options.output}", integrations: [nimbus({ site: "https://docs.example.com", title: "X", search: false${options.rendering ? `, rendering: ${options.rendering}` : ""} })] };`,
  );
  write("src/content/docs/index.mdx", "---\ntitle: Home\n---\n");
  for (const route of ROUTES) write(`src/pages/${route}`, fs.readFileSync(path.join(starterPages, route), "utf8"));
  for (const [file, text] of Object.entries(options.files ?? {})) write(file, text);
  return dir;
}

const codes = async (dir: string) =>
  (await runChecks(dir, STRUCTURE)).findings.filter((f) => f.code === "nimbus/route-file-mode").map((f) => `${f.severity} ${f.file}`);

test("check reports each route file rendering overrides, and the fix leaves nothing to report", async () => {
  const dir = project({ output: "server", rendering: '{ default: "request" }' });
  try {
    assert.deepEqual(await codes(dir), DYNAMIC.map((file) => `warn ${file}`));
    const message = (await runChecks(dir, STRUCTURE)).findings.find((f) => f.file === "src/pages/[...slug].astro")?.message;
    assert.equal(message, "src/pages/[...slug].astro: file renders on request, so Astro ignores its getStaticPaths.");

    const plan = planRouteFiles(dir);
    assert.ok(plan.ok);
    assert.deepEqual(applyRouteFiles(dir, plan.files).updated.sort(), DYNAMIC);
    assert.deepEqual(await codes(dir), []);
    assert.deepEqual(planRouteFiles(dir), { ok: true, files: [] });
    assert.equal(
      fs.readFileSync(path.join(dir, "src/pages/[...slug]/index.md.ts"), "utf8"),
      'import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\nexport const { GET } = markdownRoute();\n',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a built site matches the starter's route files", async () => {
  const dir = project({ output: "static", rendering: '{ collections: { docs: "build" } }' });
  try {
    assert.deepEqual(await codes(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a built dynamic route with no getStaticPaths is an error, and the fix restores it", async () => {
  const dir = project({
    output: "server",
    rendering: '{ default: "build" }',
    files: {
      "src/pages/[...slug].astro":
        '---\nimport { getDocsPage } from "@cloudflare/nimbus-docs/runtime";\n\nexport const prerender = true;\n\nconst page = await getDocsPage(Astro);\n---\n',
    },
  });
  try {
    assert.deepEqual(
      (await codes(dir)).sort(),
      ROUTES.map((route) => `${route === "[...slug].astro" ? "error" : "warn"} src/pages/${route}`).sort(),
    );
    const plan = planRouteFiles(dir);
    assert.ok(plan.ok);
    applyRouteFiles(dir, plan.files);
    assert.equal(
      fs.readFileSync(path.join(dir, "src/pages/[...slug].astro"), "utf8"),
      '---\nimport { getDocsStaticPaths, getDocsPage } from "@cloudflare/nimbus-docs/runtime";\n\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\n\nconst page = await getDocsPage(Astro);\n---\n',
    );
    assert.deepEqual(await codes(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a moved request route gets the page helper's argument, and a customized one the part that can be fixed", async () => {
  const dir = project({
    output: "server",
    rendering: '{ default: "request", collections: { sdk: "request" } }',
    files: {
      "src/content.config.ts": "export const collections = { docs: {}, sdk: {} };\n",
      "src/pages/products/kit/[...slug].astro":
        '---\nimport { getCollectionStaticPaths, getCollectionPage } from "@cloudflare/nimbus-docs/runtime";\n\nexport const prerender = true;\nexport const getStaticPaths = getCollectionStaticPaths("sdk");\n\nconst page = await getCollectionPage(Astro);\n---\n',
      "src/pages/[...slug].astro": "---\nexport const prerender = true;\nexport async function getStaticPaths() { return []; }\n---\n",
    },
  });
  try {
    const result = await runChecks(dir, STRUCTURE);
    const custom = result.findings.find((f) => f.file === "src/pages/[...slug].astro");
    assert.equal(custom?.fixable, true);
    assert.match(custom?.fix?.suggestion ?? "", /Remove its getStaticPaths export/);
    const plan = planRouteFiles(dir);
    assert.ok(plan.ok);
    const { manual } = applyRouteFiles(dir, plan.files);
    assert.deepEqual(manual.map((entry) => entry.file), ["src/pages/[...slug].astro"]);
    assert.equal(
      fs.readFileSync(path.join(dir, "src/pages/products/kit/[...slug].astro"), "utf8"),
      '---\nimport { getCollectionPage } from "@cloudflare/nimbus-docs/runtime";\n\nconst page = await getCollectionPage(Astro, "sdk");\n---\n',
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "src/pages/[...slug].astro"), "utf8"),
      "---\nexport async function getStaticPaths() { return []; }\n---\n",
    );
    const after = await runChecks(dir, STRUCTURE);
    assert.deepEqual(after.findings.filter((f) => f.code.startsWith("nimbus/collection-")).map((f) => f.code), []);
    const left = after.findings.find((f) => f.file === "src/pages/[...slug].astro");
    assert.equal(left?.fixable, false);
    assert.equal(left?.fix?.kind, "suggestion");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without rendering, route files are checked against building ahead of time", async () => {
  const dir = project({ output: "server" });
  try {
    const all = ROUTES.map((route) => `src/pages/${route}`).sort();
    assert.deepEqual((await codes(dir)).sort(), all.map((file) => `warn ${file}`).sort());
    const message = (await runChecks(dir, STRUCTURE)).findings.find((f) => f.file === "src/pages/llms.txt.ts")?.message;
    assert.equal(message, "src/pages/llms.txt.ts: file renders on request; with no `rendering`, Nimbus builds it ahead of time. To keep it on request, set `rendering`.");
    const plan = planRouteFiles(dir);
    assert.ok(plan.ok);
    applyRouteFiles(dir, plan.files);
    assert.deepEqual(await codes(dir), []);
    assert.match(fs.readFileSync(path.join(dir, "src/pages/llms.txt.ts"), "utf8"), /export const prerender = true;/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a comment naming getStaticPaths doesn't hide a missing one", async () => {
  const dir = project({
    output: "server",
    rendering: '{ default: "build" }',
    files: {
      "src/pages/[...slug]/index.md.ts":
        'import { markdownRoute } from "@cloudflare/nimbus-docs/agent-endpoints";\n\n// getStaticPaths comes later\nexport const prerender = true;\nexport const { GET } = markdownRoute();\n',
    },
  });
  try {
    assert.ok((await codes(dir)).includes("error src/pages/[...slug]/index.md.ts"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a route naming two collections gets one error, not a follow-on rendering one", async () => {
  const dir = project({
    output: "static",
    rendering: '{ collections: { docs: "build", sdk: "build" } }',
    files: {
      "src/content.config.ts": "export const collections = { docs: {}, sdk: {} };\n",
      "src/pages/products/sdk/[...slug].astro":
        '---\nimport { getCollectionStaticPaths, getCollectionPage } from "@cloudflare/nimbus-docs/runtime";\nexport const getStaticPaths = getCollectionStaticPaths("sdk");\nconst page = await getCollectionPage(Astro, "docs");\n---\n',
    },
  });
  try {
    const errors = (await runChecks(dir, STRUCTURE)).findings.filter((f) => f.severity === "error").map((f) => f.code);
    assert.deepEqual(errors, ["nimbus/collection-route-mismatch"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
