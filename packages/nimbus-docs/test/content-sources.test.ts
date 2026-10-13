// The `sources` config: validation, the credential refusal (no message ever
// echoes one), the `{ source, path }` form of `api[].spec`, log redaction,
// `check`'s build-free read of a templated ref and its deferral when the map
// is computed, the page bundle, and snapshot paths at runtime.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { applySourceSpecs, collectSourceSpecs, type SourceSnapshot } from "../src/_internal/content-sources.ts";
import { __resetLastUpdatedForTests, getLastUpdatedFromGit, getLastUpdatedStats } from "../src/_internal/git-last-updated.ts";
import { parseContentSourcePath } from "../src/_internal/source-paths.ts";
import { redactRepo, redactUrlUserinfo, repoCredentialFault } from "../src/_internal/source-repo.ts";
import { validateNimbusConfig } from "../src/_internal/validate.ts";
import { virtualConfigPlugin } from "../src/_internal/virtual-config.ts";
import { runChecks } from "../src/check/run.ts";
import { probeSources } from "../src/check/sources.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";

const COMMIT = "4f2c1e9a0b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";
const IDENTITY = "0123456789abcdef";
const TOKEN = "ghp_secret_abc123XYZ";
const base = { site: "https://docs.example.test", title: "Docs", search: false };

function invalid(config: unknown): string {
  try {
    validateNimbusConfig(config);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the config to be rejected");
}

test("a valid sources map normalises path and accepts a commit, a branch, a tag and ssh usernames", () => {
  const config = validateNimbusConfig({
    ...base,
    sources: {
      sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "./docs/" },
      cli: { repo: "git@github.com:acme/cli.git", ref: "main" },
      ssh: { repo: "ssh://git@github.com/acme/ssh.git", ref: "main" },
      "api-v2": { repo: "../api", ref: "v2.1.0", path: "" },
    },
  });
  assert.deepEqual(config.sources, {
    sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" },
    cli: { repo: "git@github.com:acme/cli.git", ref: "main", path: "" },
    ssh: { repo: "ssh://git@github.com/acme/ssh.git", ref: "main", path: "" },
    "api-v2": { repo: "../api", ref: "v2.1.0", path: "" },
  });
});

test("an abbreviated commit, a bad ref, a bad name, a parent path, and an unknown key are rejected", () => {
  assert.match(
    invalid({ ...base, sources: { sdk: { repo: "x", ref: COMMIT.slice(0, 12) } } }),
    /sources\.sdk\.ref: "sources\.<name>\.ref" looks like an abbreviated commit\. Use the full 40-character commit/,
  );
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "-rf" } } }), /must be a 40-character commit or a branch or tag name/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "feature..x" } } }), /must be a 40-character commit or a branch or tag name/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "" } } }), /must not be empty/);
  assert.match(invalid({ ...base, sources: { SDK: { repo: "x", ref: "main" } } }), /source name "SDK" must be lowercase letters, digits, and dashes/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "main", path: "../docs" } } }), /must not contain a "\.\." segment/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "main", path: "/docs" } } }), /must be relative to the repository root/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "main", branch: "main" } } }), /sources field "branch"/);
  assert.match(invalid({ ...base, sources: { sdk: { ref: "main" } } }), /sources\.sdk\.repo/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "--upload-pack=x", ref: "main" } } }), /must not start with "-"/);
});

test("a credential in repo fails validation in every shape, and no message carries any part of it", () => {
  const shapes = [
    `https://x-access-token:${TOKEN}@github.com/acme/sdk.git`, // token as password
    `https://${TOKEN}@github.com/acme/sdk.git`, // token as username
    `https://${TOKEN}:x-oauth-basic@github.com/acme/sdk.git`,
    "https://user:ab@github.com/acme/sdk.git", // a two-character password
    `https://user:${encodeURIComponent(`${TOKEN}/+=`)}@github.com/acme/sdk.git`, // percent-encoded
    `ssh://git:${TOKEN}@github.com/acme/sdk.git`,
    `git:${TOKEN}@github.com:acme/sdk.git`,
  ];
  for (const repo of shapes) {
    const message = invalid({ ...base, sources: { sdk: { repo, ref: "main" } } });
    assert.match(message, /sources\.sdk\.repo: "sources\.<name>\.repo" has (a username or token|a password) in the URL/, repo);
    assert.match(message, /\*\*\*@/);
    assert.match(message, /credential helper/);
    for (const part of [TOKEN, encodeURIComponent(`${TOKEN}/+=`), "user:ab", ":ab@"]) {
      assert.ok(!message.includes(part), `${repo}: ${message}`);
    }
  }
  // Other faults in the same entry never echo the URL either.
  const repo = `https://x-access-token:${TOKEN}@github.com/acme/sdk.git`;
  for (const message of [
    invalid({ ...base, sources: { sdk: { repo, ref: "-x" } } }),
    invalid({ ...base, sources: { sdk: { repo, ref: "main", extra: 1 } } }),
    invalid({ ...base, sources: { Sdk: { repo, ref: "main" } } }),
  ]) {
    assert.ok(!message.includes(TOKEN), message);
  }
  assert.equal(repoCredentialFault("git@github.com:acme/sdk.git"), undefined);
  assert.equal(repoCredentialFault("ssh://git@github.com/acme/sdk.git"), undefined);
  assert.equal(repoCredentialFault("/srv/git/sdk.git"), undefined);
});

test("git's output loses every URL's userinfo, raw or percent-encoded, at any length", () => {
  assert.equal(
    redactUrlUserinfo(`fatal: Authentication failed for 'https://x:${TOKEN}@host/r.git/'`),
    "fatal: Authentication failed for 'https://***@host/r.git/'",
  );
  assert.equal(redactUrlUserinfo("remote: https://a@h/x and https://h/y"), "remote: https://***@h/x and https://h/y");
  assert.equal(redactUrlUserinfo(`url=https%3A%2F%2F${TOKEN}%40host%2Fr`), "url=https%3A%2F%2F***@host%2Fr");
  assert.equal(redactUrlUserinfo("fatal: git@host: denied"), "fatal: git@host: denied");
  assert.equal(redactRepo(`https://${TOKEN}@github.com/acme/sdk.git`), "https://***@github.com/acme/sdk.git");
});

test("api[].spec: { source, path } names a declared source and a file inside its path", () => {
  const sources = { sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" } };
  const ok = validateNimbusConfig({ ...base, sources, api: [{ collection: "api", spec: { source: "sdk", path: "docs/openapi.json" } }] });
  assert.deepEqual(ok.api?.[0]?.spec, { source: "sdk", path: "docs/openapi.json" });
  assert.match(
    invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "cli", path: "openapi.json" } }] }),
    /api\.0\.spec\.source: api collection "api" reads its spec from source "cli", which "sources" doesn't declare\. Declared: "sdk"/,
  );
  assert.match(
    invalid({ ...base, api: [{ collection: "api", spec: { source: "sdk", path: "openapi.json" } }] }),
    /Add sources: \{ "sdk": \{ repo, ref, path \} \} to the config/,
  );
  assert.match(
    invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "sdk", path: "openapi.json" } }] }),
    /reads "openapi\.json" from source "sdk", but that source checks out only "docs\/"\. Widen sources\.sdk\.path/,
  );
  assert.match(invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "sdk" } }] }), /names no file/);
  // Deferred when `check` can't read the map: everything else still validates.
  assert.doesNotThrow(() =>
    validateNimbusConfig({ ...base, api: [{ collection: "api", spec: { source: "sdk", path: "x.json" } }] }, { deferSources: true }),
  );
  const inline = validateNimbusConfig({ ...base, api: [{ collection: "api", spec: { openapi: "3.1.0", source: "x" } }] });
  assert.equal((inline.api?.[0]?.spec as { openapi: string }).openapi, "3.1.0");
});

test("source-backed specs are found once and pointed at each run's snapshot", () => {
  const api = [
    { collection: "api", spec: { source: "sdk", path: "./docs/openapi.json" } },
    { collection: "local", spec: "./specs/local.yaml" },
    { collection: "family", versions: [{ version: "v1", spec: { source: "sdk", path: "v1.json" } }] },
  ];
  const specs = collectSourceSpecs(api as never);
  assert.deepEqual(specs.map((spec) => [spec.source, spec.path]), [["sdk", "docs/openapi.json"], ["sdk", "v1.json"]]);
  const root = "/site";
  const snapshot = (commit: string): SourceSnapshot => {
    const dir = path.join(root, ".nimbus/sources/sdk", IDENTITY, commit);
    return { name: "sdk", identity: IDENTITY, commit, path: "", dir, contentDir: dir, floating: false };
  };
  applySourceSpecs(specs, new Map([["sdk", snapshot(COMMIT)]]), root);
  assert.equal(api[0]!.spec, `.nimbus/sources/sdk/${IDENTITY}/${COMMIT}/docs/openapi.json`);
  assert.equal((api[2] as { versions: { spec: unknown }[] }).versions[0]!.spec, `.nimbus/sources/sdk/${IDENTITY}/${COMMIT}/v1.json`);
  assert.equal(api[1]!.spec, "./specs/local.yaml");
  assert.throws(() => applySourceSpecs(specs, new Map(), root), /which the Nimbus config doesn't declare/);
});

test("check reads a sources literal whose refs are templated, and gives up on anything else computed", () => {
  const templated = probeSources(`{
    sdk: { repo: "https://github.com/acme/sdk.git", ref: process.env.SDK_DOCS_REF ?? "${COMMIT}", path: "docs" },
    cli: { repo: "https://github.com/acme/cli.git", ref: (process.env.CLI_REF || "main") },
    pinned: { repo: "https://github.com/acme/api.git", ref: "${COMMIT}" },
  }`);
  assert.deepEqual(templated?.probe, {
    sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" },
    cli: { repo: "https://github.com/acme/cli.git", ref: "main" },
    pinned: { repo: "https://github.com/acme/api.git", ref: COMMIT },
  });
  assert.deepEqual([...templated!.templated].sort(), ["cli", "sdk"]);
  assert.equal(probeSources(`{ sdk: { repo: process.env.SDK_REPO, ref: "main" } }`), null);
  assert.equal(probeSources(`{ ...shared }`), null);
});

function checkProject(sources: string, contentConfig: string, api = `[{ collection: "api", spec: { source: "sdk", path: "docs/openapi.json" } }]`) {
  const dir = mkdtempSync(path.join(TEST_TMP, "nimbus-sources-check-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
const nimbusConfig = defineNimbusConfig({
  site: "https://example.test",
  title: "Test",
  search: false,
  sources: ${sources},
  api: ${api},
});
export default defineConfig({ integrations: [nimbus(nimbusConfig)] });
`,
  );
  writeFileSync(path.join(dir, "src/content.config.ts"), contentConfig);
  return dir;
}

const CONTENT = `import { defineCollection } from "astro:content";
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ source: "sdk", base: "guides" })),
  api: defineCollection(apiCollection()),
};
`;

test("check: a templated ref keeps readiness, a branch floats, an unread source is reported", async () => {
  const dir = checkProject(
    `{
    sdk: { repo: "https://github.com/acme/sdk.git", ref: process.env.SDK_DOCS_REF ?? "${COMMIT}", path: "docs" },
    cli: { repo: "https://github.com/acme/cli.git", ref: "main" },
  }`,
    CONTENT,
  );
  try {
    const result = await runChecks(dir, { env: false, structure: true, migrations: false, authoring: false, types: false });
    const codes = result.findings.map((finding) => finding.code).sort();
    assert.ok(!codes.includes("nimbus/config-invalid"), JSON.stringify(result.findings));
    assert.ok(!result.scopes[0]!.notes.some((note) => note.code === "nimbus/config-unresolved"), "templated ref stays readable");
    const floating = result.findings.filter((finding) => finding.code === "nimbus/source-floating-ref");
    assert.deepEqual(floating.map((finding) => finding.message.split(" ")[0]), ["sources.cli"]);
    const unread = result.findings.filter((finding) => finding.code === "nimbus/source-unreferenced");
    assert.deepEqual(unread.map((finding) => finding.message.split(" ")[0]), ["sources.cli"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check: a computed repo defers the source checks only; a literal map without the spec's source still fails", async () => {
  const computed = checkProject(`{ sdk: { repo: process.env.SDK_REPO, ref: "main", path: "docs" } }`, CONTENT);
  const missing = checkProject(`{ cli: { repo: "https://github.com/acme/cli.git", ref: "${COMMIT}" } }`, CONTENT);
  try {
    const scopes = { env: false, structure: true, migrations: false, authoring: false, types: false };
    const deferred = await runChecks(computed, scopes);
    assert.ok(!deferred.findings.some((finding) => finding.code === "nimbus/config-invalid"), JSON.stringify(deferred.findings));
    assert.ok(deferred.scopes[0]!.notes.some((note) => note.code === "nimbus/config-unresolved" && /`sources`/.test(note.reason)));
    const failed = await runChecks(missing, scopes);
    const invalidFinding = failed.findings.find((finding) => finding.code === "nimbus/config-invalid");
    assert.match(invalidFinding?.message ?? "", /reads its spec from source "sdk", which "sources" doesn't declare/);
  } finally {
    rmSync(computed, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("a source editPattern needs {path}, and the page bundle gets only ref and editPattern", async () => {
  assert.match(
    invalid({ ...base, sources: { sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, editPattern: "https://github.com/acme/sdk/edit/main/docs" } } }),
    /"sources\.<name>\.editPattern" must contain the "\{path\}" placeholder/,
  );
  const config = validateNimbusConfig({
    ...base,
    sources: {
      sdk: { repo: "https://github.com/acme/sdk.git", ref: "main", path: "docs", editPattern: "https://github.com/acme/sdk/edit/{ref}/{path}" },
      cli: { repo: "https://github.com/acme/cli.git", ref: COMMIT },
    },
  });
  const plugin = virtualConfigPlugin(config, {
    getIndexedCollections: async () => ["docs"],
    requestRenderingCollections: [],
    versionAlternates: {},
    apiCollections: [],
    headDefaults: {
      favicon: { file: "/favicon.ico", type: "image/x-icon" },
      socialImage: "/opengraph.png",
      ogCard: { sitePath: "/og.png", pagePrefix: "/og/", size: { width: 1200, height: 630 } },
      imageSizes: {},
    },
  } as never);
  const bundle = String((await (plugin as { load: (id: string) => unknown }).load("\0virtual:nimbus/config")) ?? "");
  const runtime = JSON.parse(/export const config = (.*);/.exec(bundle)![1]!) as { sources?: Record<string, unknown> };
  assert.deepEqual(runtime.sources, { sdk: { ref: "main", editPattern: "https://github.com/acme/sdk/edit/{ref}/{path}" } });
  assert.ok(!bundle.includes("acme/cli") && !bundle.includes("sdk.git"), "repo never reaches the bundle");
});

test("a snapshot path splits into source, identity, commit and repository path, and gets no git date", async () => {
  assert.deepEqual(parseContentSourcePath(`.nimbus/sources/sdk/${IDENTITY}/${COMMIT}/docs/guides/install.md`), {
    name: "sdk",
    identity: IDENTITY,
    commit: COMMIT,
    path: "docs/guides/install.md",
  });
  assert.equal(parseContentSourcePath("src/content/docs/guide.md"), undefined);
  assert.equal(parseContentSourcePath(`.nimbus/sources/sdk/${COMMIT}/docs/a.md`), undefined);
  __resetLastUpdatedForTests();
  try {
    for (let i = 0; i < 60; i++) {
      assert.equal(await getLastUpdatedFromGit(`.nimbus/sources/sdk/${IDENTITY}/${COMMIT}/docs/page-${i}.md`), undefined);
    }
    assert.equal(getLastUpdatedStats().missCount, 0);
  } finally {
    __resetLastUpdatedForTests();
  }
});
