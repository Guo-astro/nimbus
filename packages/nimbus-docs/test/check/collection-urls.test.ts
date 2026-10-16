import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatCheckJson, formatCheckPretty } from "../../src/check/format.js";
import { runChecks } from "../../src/check/run.js";

const STRUCTURE = { env: false, structure: true, authoring: false, types: false, migrations: false };
const OPTS = { color: false, invocation: "nimbus-docs check", rerun: "nimbus-docs check" };

function project(routes: Record<string, string>, options: { config?: string; files?: Record<string, string> } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-collection-urls-"));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write("package.json", `{ "name": "fixture" }`);
  write(
    "astro.config.ts",
    `import nimbus from "@cloudflare/nimbus-docs";
export default { integrations: [nimbus({ site: "https://docs.example.com", title: "X", search: false, api: [{ collection: "api", spec: "./spec.json" }]${options.config ?? ""} })] };`,
  );
  for (const [file, text] of Object.entries(options.files ?? {})) write(file, text);
  for (const [file, collection] of Object.entries(routes))
    write(
      file,
      `---\nimport { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport const getStaticPaths = getCollectionStaticPaths("${collection}");\n---\n`,
    );
  return dir;
}

test("check lists each collection's URL and where it comes from, in pretty output and --json", async () => {
  const dir = project(
    { "src/pages/products/kit/[...slug].astro": "sdk" },
    { files: { "src/content/docs/index.mdx": "---\ntitle: Home\n---\n" } },
  );
  try {
    const result = await runChecks(dir, STRUCTURE);
    assert.equal(result.summary.errors, 0);
    assert.deepEqual(
      result.collections?.map(({ name, url, source }) => [name, url, source]),
      [
        ["docs", "/", "root collection"],
        ["api", "/api", "default (no route found)"],
        ["sdk", "/products/kit", "src/pages/products/kit/[...slug].astro"],
      ],
    );
    const pretty = formatCheckPretty(result, OPTS);
    assert.match(pretty, /Collection URLs\n {4}docs {2}\/ +root collection\n/);
    assert.match(pretty, / {4}sdk {3}\/products\/kit {2}src\/pages\/products\/kit\/\[\.\.\.slug\]\.astro/);
    const json = JSON.parse(formatCheckJson(result)) as { collections: unknown };
    assert.deepEqual(json.collections, result.collections!.map(({ name, url, source }) => ({ name, url, source })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check prints no table when every collection is at its default URL, and --json still lists them", async () => {
  const dir = project({ "src/pages/sdk/[...slug].astro": "sdk" });
  try {
    const result = await runChecks(dir, STRUCTURE);
    assert.doesNotMatch(formatCheckPretty(result, OPTS), /Collection URLs/);
    const { collections } = JSON.parse(formatCheckJson(result)) as { collections: Array<{ name: string }> };
    assert.deepEqual(collections.map(({ name }) => name), ["api", "sdk"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check warns about a helper route it can't read, away from any default URL", async () => {
  const dir = project({}, {
    files: {
      "src/pages/products/kit/[...slug].astro":
        '---\nimport { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nimport { wrap } from "../../../lib/wrap";\nexport const getStaticPaths = wrap(getCollectionStaticPaths("sdk"));\n---\n',
    },
  });
  try {
    const result = await runChecks(dir, STRUCTURE);
    const finding = result.findings.find((f) => f.code === "nimbus/collection-unread-route");
    assert.equal(finding?.severity, "warn");
    assert.match(finding!.message, /src\/pages\/products\/kit\/\[\.\.\.slug\]\.astro.*#collection-urls/s);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a route that breaks a collection's URL is a check error with its code and the docs link", async () => {
  const dir = project({ "src/pages/a/[...slug].astro": "sdk", "src/pages/b/[...slug].astro": "sdk" });
  try {
    const result = await runChecks(dir, STRUCTURE);
    const finding = result.findings.find((f) => f.code === "nimbus/collection-two-routes");
    assert.equal(finding?.severity, "error");
    assert.match(finding!.message, /#collection-urls/);
    assert.ok((JSON.parse(formatCheckJson(result)) as { findings: Array<{ code: string }> }).findings.some((f) => f.code === "nimbus/collection-two-routes"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check reports a page under a moved collection's URL, rendered at build or on request", async () => {
  const dir = project(
    { "src/pages/products/kit/[...slug].astro": "sdk" },
    {
      config: `, rendering: { default: "build", collections: { sdk: "request" } }`,
      files: { "src/content/docs/products/kit/overview.mdx": "---\ntitle: Overview\n---\n" },
    },
  );
  try {
    const result = await runChecks(dir, STRUCTURE);
    const codes = result.findings.filter((f) => f.severity === "error").map((f) => f.code);
    assert.deepEqual(codes.filter((code) => code.startsWith("nimbus/collection-")), ["nimbus/collection-owns-url"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("before a build, a site without docs can serve another collection at the root", async () => {
  const dir = project({ "src/pages/[...slug].astro": "guides" }, { files: { "src/content/guides/intro.mdx": "---\ntitle: Intro\n---\n" } });
  try {
    const result = await runChecks(dir, STRUCTURE);
    assert.deepEqual(result.findings.filter((f) => f.code.startsWith("nimbus/collection-")).map((f) => f.code), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collection checks read routes and pages under the srcDir passed to check", async () => {
  const dir = project(
    { "site/pages/products/kit/[...slug].astro": "sdk" },
    { files: { "site/content/docs/products/kit/overview.mdx": "---\ntitle: Overview\n---\n" } },
  );
  try {
    const result = await runChecks(dir, STRUCTURE, { srcDir: "site" });
    assert.equal(result.collections?.find((c) => c.name === "sdk")?.url, "/products/kit");
    const owned = result.findings.find((f) => f.code === "nimbus/collection-owns-url");
    assert.match(owned?.message ?? "", /site\/content\/docs\/products\/kit\/overview\.mdx/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
