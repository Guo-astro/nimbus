import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseNimbusConfig } from "../../src/_internal/parse-nimbus-config.js";
import { checkStructure } from "../../src/check/structure.js";

async function check(
  nimbus: string,
  astro = "",
  setup = "",
  sdkInstalled = false,
) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-check-"));
  try {
    if (sdkInstalled) {
      const sdk = path.join(
        cwd,
        "node_modules",
        "@modelcontextprotocol",
        "server",
      );
      fs.mkdirSync(sdk, { recursive: true });
      fs.writeFileSync(
        path.join(sdk, "package.json"),
        JSON.stringify({ exports: "./index.js" }),
      );
      fs.writeFileSync(path.join(sdk, "index.js"), "export {};\n");
    }
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    );
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

test("MCP preflight requires the SDK to resolve from the project", async () => {
  const config = "agents: { mcp: true }";
  const astro = 'output: "server", adapter: cloudflare()';
  const missing = await check(config, astro);
  assert.ok(missing.findings.some((f) => f.code === "nimbus/mcp-sdk-missing"));
  const installed = await check(config, astro, "", true);
  assert.ok(
    !installed.findings.some((f) => f.code === "nimbus/mcp-sdk-missing"),
  );
});

test("server features fail preflight without a configured adapter", async () => {
  for (const config of [
    "agents: { mcp: true }",
    'rendering: { default: "request" }',
    'api: [{ collection: "api", spec: "./api.json", bundle: false }], rendering: { collections: { api: "request" } }',
  ]) {
    const report = await check(config);
    const finding = report.findings.find(
      (f) => f.code === "nimbus/server-adapter-missing",
    );
    assert.equal(finding?.severity, "error", config);
    assert.match(
      finding!.message,
      /pnpm dlx @cloudflare\/nimbus-docs add adapter-cloudflare/,
    );
  }
});

test("an adapter requires server output for request rendering and MCP", async () => {
  const report = await check("agents: { mcp: true }", "adapter: cloudflare()");
  assert.ok(
    report.findings.some((f) => f.code === "nimbus/server-adapter-missing"),
  );
});

test("configured server output clears the prerequisite but not the request-build note", async () => {
  const report = await check(
    'rendering: { default: "request" }',
    'output: "server", adapter: cloudflare()',
  );
  assert.ok(
    !report.findings.some((f) => f.code === "nimbus/server-adapter-missing"),
  );
  assert.ok(
    report.notes.some(
      (n) => n.code === "nimbus/request-rendering-build-required",
    ),
  );
});

test("computed, spread, wrapped and mutated Astro configs remain unconfirmed", async () => {
  for (const [astro, setup] of [
    ["...loadConfig()", ""],
    ['[key]: cloudflare(), output: "server"', ""],
    ['get [key]() { return cloudflare(); }, output: "server"', ""],
    ['[key]() { return cloudflare(); }, output: "server"', ""],
    ['output: "server", adapter: enabled ? cloudflare() : undefined', ""],
    ["wrap({ integrations })", ""],
    ["config", "let config = { integrations }; config = loadConfig();"],
    [
      "config",
      "const config = { integrations }; config.adapter = cloudflare();",
    ],
    ["config", "const config = { integrations }; configure(config);"],
  ]) {
    const report = await check("agents: { mcp: true }", astro, setup);
    assert.ok(
      !report.findings.some((f) => f.code === "nimbus/server-adapter-missing"),
      astro + setup,
    );
    assert.ok(
      report.notes.some((n) => n.code === "nimbus/server-adapter-unconfirmed"),
      astro + setup,
    );
  }
});

test("disabled MCP and effectively build-rendered collections need no adapter", async () => {
  const report = await check(
    'agents: { mcp: false }, rendering: { default: "request", collections: { docs: "build" } }',
  );
  assert.ok(
    !report.findings.some((f) => f.code === "nimbus/server-adapter-missing"),
  );
  assert.ok(
    !report.notes.some((n) => n.code === "nimbus/server-adapter-unconfirmed"),
  );
});

test("Nimbus shorthand and computed feature keys remain unconfirmed", async () => {
  for (const config of [
    "agents",
    "[key]: { mcp: true }",
    "agents: { mcp: true }, agents",
  ]) {
    const report = await check(
      config,
      'output: "server", adapter: cloudflare()',
      'const agents = { mcp: true }; const key = "agents";',
    );
    assert.ok(
      report.notes.some((n) => n.code === "nimbus/config-unresolved"),
      config,
    );
    assert.ok(
      !report.findings.some((f) => f.code === "nimbus/config-invalid"),
      config,
    );
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
  const report = await check(
    `${api}, rendering: { default: "build" }, ...serverSettings`,
  );
  assert.ok(!report.findings.some((f) => f.code === "nimbus/config-invalid"));
  assert.ok(report.notes.some((n) => n.code === "nimbus/config-unresolved"));
  const literalOverride = await check(
    `...serverSettings, ${api}, rendering: { default: "build" }`,
  );
  assert.ok(
    literalOverride.findings.some((f) => f.code === "nimbus/config-invalid"),
  );
});

test("an opaque accessor cannot leave an overridden rendering policy behind", async () => {
  const api = 'api: [{ collection: "api", spec: "./api.json", bundle: false }]';
  for (const accessor of [
    'get rendering() { return { default: "request" }; }',
    'get rendering(): { default: "request" } { return { default: "request" }; }',
  ]) {
    const report = await check(
      `${api}, rendering: { default: "build" }, ${accessor}`,
    );
    assert.ok(
      !report.findings.some((f) => f.code === "nimbus/config-invalid"),
      accessor,
    );
    assert.ok(
      report.notes.some((n) => n.code === "nimbus/config-unresolved"),
      accessor,
    );
    const literalOverride = await check(
      `${accessor}, ${api}, rendering: { default: "build" }`,
    );
    assert.ok(
      literalOverride.findings.some((f) => f.code === "nimbus/config-invalid"),
      accessor,
    );
  }
});
