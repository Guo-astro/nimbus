import assert from "node:assert/strict";
import { test } from "node:test";
import { validateNimbusConfig } from "../src/_internal/validate.js";

const site = { site: "https://docs.example.com", title: "Example" };

test("a differently cased MCP key suggests the supported mcp spelling", () => {
  for (const key of ["MCP", "Mcp", "mCp"]) {
    assert.throws(
      () => validateNimbusConfig({ ...site, agents: { [key]: true } }),
      /Unknown agents sub-key.*Did you mean `mcp`\?/s,
    );
  }
});

test("agents.mcp is a boolean under a strict agents block", () => {
  assert.equal(validateNimbusConfig({ ...site, agents: { mcp: true } }).agents?.mcp, true);
  assert.equal(validateNimbusConfig({ ...site, agents: {} }).agents?.mcp, undefined);
  assert.equal(validateNimbusConfig(site).agents, undefined);
  assert.throws(() => validateNimbusConfig({ ...site, agents: { mcp: "yes" } }), /"agents.mcp" must be true or false/);
  assert.throws(() => validateNimbusConfig({ ...site, agents: { search: true } }), /Unknown agents sub-key "search"/);
  assert.throws(() => validateNimbusConfig({ ...site, agents: true }), /agents/);
});

test("agents.discovery accepts only false", () => {
  assert.equal(validateNimbusConfig({ ...site, agents: { discovery: false } }).agents?.discovery, false);
  for (const discovery of [true, "off", {}]) {
    assert.throws(
      () => validateNimbusConfig({ ...site, agents: { discovery } }),
      /"agents.discovery" must be false/,
      JSON.stringify(discovery),
    );
  }
  assert.throws(() => validateNimbusConfig({ ...site, agents: { Discovery: false } }), /Did you mean `discovery`\?/);
});
