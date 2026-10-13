import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseNimbusConfig } from "../../src/_internal/parse-nimbus-config.js";
import { checkStructure } from "../../src/check/structure.js";

async function check(nimbus: string, astro = "", setup = "") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-check-"));
  try {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
    fs.writeFileSync(
      path.join(cwd, "astro.config.ts"),
      `
      import nimbus from "@cloudflare/nimbus-docs";
      import { defineConfig } from "astro/config";
      const integrations = [nimbus({ site: "https://docs.example.com", title: "Docs", search: false, ${nimbus} })];
      ${setup}
      export default ${astro.startsWith("config") || astro.startsWith("wrap(") ? astro : `{ integrations, ${astro} }`};
    `,
    );
    fs.mkdirSync(path.join(cwd, "src", "pages"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "pages", "[...slug].astro"), "");
    return await checkStructure(cwd, parseNimbusConfig(cwd));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const missing = (report: Awaited<ReturnType<typeof check>>) =>
  report.findings.filter((f) => f.code === "nimbus/server-adapter-missing");
const unconfirmed = (report: Awaited<ReturnType<typeof check>>) =>
  report.notes.some((n) => n.code === "nimbus/server-adapter-unconfirmed");

test("server features fail preflight without a configured adapter", async () => {
  for (const config of [
    "agents: { mcp: true }",
    'rendering: { default: "request" }',
    'api: [{ collection: "api", spec: "./api.json", bundle: false }], rendering: { collections: { api: "request" } }',
  ]) {
    const [finding] = missing(await check(config));
    assert.equal(finding?.severity, "error", config);
    assert.match(finding!.message, /pnpm dlx @cloudflare\/nimbus-docs add adapter-<host>`, where <host> is /);
  }
});

test("several server features report the missing adapter once, with the strictest requirement", async () => {
  const report = await check(
    'agents: { mcp: true }, api: [{ collection: "api", spec: "./api.json", bundle: false }], rendering: { default: "request" }',
  );
  assert.equal(missing(report).length, 1);
  assert.match(missing(report)[0]!.message, /api bundle: false needs the Cloudflare or Node adapter/);
  assert.doesNotMatch(missing(report)[0]!.message, /vercel|netlify/);
});

test("MCP with request rendering names request rendering, without offering to turn MCP off", async () => {
  const [finding, ...rest] = missing(await check('agents: { mcp: true }, rendering: { default: "request" }'));
  assert.deepEqual(rest, []);
  assert.match(finding!.message, /rendering mode "request" needs a server adapter/);
  assert.doesNotMatch(finding!.message, /agents\.mcp/);
  assert.match(missing(await check("agents: { mcp: true }"))[0]!.message, /Or set agents\.mcp to false\./);
});

test("an adapter is enough: Astro builds server output for on-demand routes", async () => {
  for (const astro of ["adapter: cloudflare()", 'output: "static", adapter: cloudflare()']) {
    assert.deepEqual(missing(await check("agents: { mcp: true }", astro)), [], astro);
  }
  assert.equal(missing(await check("agents: { mcp: true }", 'output: "server", adapter: null')).length, 1);
});

test("an adapter set through a const export chain is read", async () => {
  for (const setup of [
    "const config = defineConfig({ integrations, adapter: cloudflare() });",
    `const config = defineConfig({ integrations, adapter: cloudflare() });
     const helper = { config: true, hooks: { "astro:config:setup": ({ config }) => config } };`,
  ]) {
    const report = await check("agents: { mcp: true }", "config", setup);
    assert.deepEqual(missing(report), [], setup);
    assert.ok(!unconfirmed(report), setup);
  }
});

test("configured server output clears the prerequisite but not the request-build note", async () => {
  const report = await check('rendering: { default: "request" }', 'output: "server", adapter: cloudflare()');
  assert.deepEqual(missing(report), []);
  assert.ok(report.notes.some((n) => n.code === "nimbus/request-rendering-build-required"));
});

test("computed, spread, wrapped and mutated Astro configs remain unconfirmed", async () => {
  for (const [astro, setup] of [
    ["...loadConfig()", ""],
    ['[key]: cloudflare(), output: "server"', ""],
    ['get [key]() { return cloudflare(); }, output: "server"', ""],
    ['[key]() { return cloudflare(); }, output: "server"', ""],
    ['output: "server", adapter: enabled ? cloudflare() : undefined', ""],
    ["adapter", "const adapter = cloudflare();"],
    ["wrap({ integrations })", ""],
    ["config", "let config = { integrations }; config = loadConfig();"],
    ["config", "const config = { integrations }; config.adapter = cloudflare();"],
    ["config", "const config = { integrations }; configure(config);"],
  ]) {
    const report = await check("agents: { mcp: true }", astro, setup);
    assert.deepEqual(missing(report), [], astro + setup);
    assert.ok(unconfirmed(report), astro + setup);
  }
});

test("disabled MCP and effectively build-rendered collections need no adapter", async () => {
  const report = await check('agents: { mcp: false }, rendering: { default: "request", collections: { docs: "build" } }');
  assert.deepEqual(missing(report), []);
  assert.ok(!unconfirmed(report));
});

test("Nimbus shorthand and computed feature keys remain unconfirmed", async () => {
  for (const config of ["agents", "[key]: { mcp: true }", "agents: { mcp: true }, agents"]) {
    const report = await check(config, 'output: "server", adapter: cloudflare()', 'const agents = { mcp: true }; const key = "agents";');
    assert.ok(report.notes.some((n) => n.code === "nimbus/config-unresolved"), config);
    assert.ok(!report.findings.some((f) => f.code === "nimbus/config-invalid"), config);
  }
});

test("computed rendering does not falsely reject a literal unbundled API", async () => {
  const report = await check(
    'api: [{ collection: "api", spec: "./api.json", bundle: false }], rendering: modes',
    'output: "server", adapter: cloudflare()',
    'const modes = { default: "request" };',
  );
  assert.ok(!report.findings.some((f) => f.code === "nimbus/config-invalid"));
  assert.ok(report.notes.some((n) => n.code === "nimbus/config-unresolved"));
});

test("an opaque spread can override an earlier rendering policy", async () => {
  const api = 'api: [{ collection: "api", spec: "./api.json", bundle: false }]';
  const report = await check(`${api}, rendering: { default: "build" }, ...serverSettings`);
  assert.ok(!report.findings.some((f) => f.code === "nimbus/config-invalid"));
  assert.ok(report.notes.some((n) => n.code === "nimbus/config-unresolved"));
  const literalOverride = await check(`...serverSettings, ${api}, rendering: { default: "build" }`);
  assert.ok(literalOverride.findings.some((f) => f.code === "nimbus/config-invalid"));
});

test("an opaque accessor cannot leave an overridden rendering policy behind", async () => {
  const api = 'api: [{ collection: "api", spec: "./api.json", bundle: false }]';
  for (const accessor of [
    'get rendering() { return { default: "request" }; }',
    'get rendering(): { default: "request" } { return { default: "request" }; }',
  ]) {
    const report = await check(`${api}, rendering: { default: "build" }, ${accessor}`);
    assert.ok(!report.findings.some((f) => f.code === "nimbus/config-invalid"), accessor);
    assert.ok(report.notes.some((n) => n.code === "nimbus/config-unresolved"), accessor);
    const literalOverride = await check(`${accessor}, ${api}, rendering: { default: "build" }`);
    assert.ok(literalOverride.findings.some((f) => f.code === "nimbus/config-invalid"), accessor);
  }
});
