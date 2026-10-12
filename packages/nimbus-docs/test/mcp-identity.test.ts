import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  MCP_CARD_MEDIA_TYPE,
  MCP_CARD_SCHEMA,
  MCP_FALLBACK_NAME,
  mcpCardUrl,
  mcpServerCard,
  mcpServerIdentity,
  mcpServerName,
  mcpUrl,
} from "../src/_internal/mcp/identity.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const schema = JSON.parse(
  readFileSync(new URL("./fixtures/mcp/server-card.schema.json", import.meta.url), "utf8"),
);
const validateCard = ajv.compile({ ...schema, $ref: "#/$defs/ServerCard" });

test("the server name is the reversed hostname plus /docs, ports and case dropped", () => {
  assert.equal(mcpServerName("https://docs.example.com"), "com.example.docs/docs");
  assert.equal(mcpServerName("https://docs.example.com:8443/"), "com.example.docs/docs");
  assert.equal(mcpServerName("https://Docs.Example.COM."), "com.example.docs/docs");
  assert.equal(mcpServerName("https://bücher.example"), "example.xn--bcher-kva/docs");
  assert.equal(mcpServerName("https://my-site.pages.dev"), "dev.pages.my-site/docs");
});

test("localhost, IP literals, unparseable sites and over-long names fall back", () => {
  assert.equal(mcpServerName("http://localhost:4321"), MCP_FALLBACK_NAME);
  assert.equal(mcpServerName("http://docs.localhost"), MCP_FALLBACK_NAME);
  assert.equal(mcpServerName("http://127.0.0.1"), MCP_FALLBACK_NAME);
  assert.equal(mcpServerName("http://[::1]:8787"), MCP_FALLBACK_NAME);
  assert.equal(mcpServerName("not a url"), MCP_FALLBACK_NAME);
  const long = `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(20)}.example`;
  assert.equal(mcpServerName(long), MCP_FALLBACK_NAME);
  assert.equal(MCP_FALLBACK_NAME, "local.nimbus/docs");
});

test("every derived name validates against the pinned schema's name rule", () => {
  const pattern = new RegExp(schema.$defs.ServerCard.properties.name.pattern);
  for (const site of [
    "https://docs.example.com",
    "https://bücher.example",
    "http://localhost:4321",
    "http://10.0.0.1",
    "https://a.b.c.d.e.f.g.h.example",
  ]) {
    const name = mcpServerName(site);
    assert.match(name, pattern);
    assert.ok(name.length <= schema.$defs.ServerCard.properties.name.maxLength);
  }
});

test("the endpoint and card URLs sit under site and base", () => {
  assert.equal(mcpUrl("https://docs.example.com", "/"), "https://docs.example.com/mcp");
  assert.equal(mcpUrl("https://docs.example.com", "/docs/"), "https://docs.example.com/docs/mcp");
  assert.equal(mcpUrl("https://docs.example.com", "/docs"), "https://docs.example.com/docs/mcp");
  assert.equal(mcpUrl("https://docs.example.com", "/", "always"), "https://docs.example.com/mcp/");
  assert.equal(mcpUrl("https://docs.example.com", "/docs/", "never"), "https://docs.example.com/docs/mcp");
  assert.equal(mcpCardUrl("https://docs.example.com/mcp/"), "https://docs.example.com/mcp/server-card");
  assert.equal(mcpCardUrl("https://docs.example.com/docs/mcp"), "https://docs.example.com/docs/mcp/server-card");
});

test("the card validates as $defs.ServerCard, names the live endpoint and carries no capabilities", () => {
  const identity = mcpServerIdentity({
    site: "https://docs.example.com",
    base: "/docs/",
    title: "Example",
    version: "0.19.0",
  });
  const card = mcpServerCard(identity);
  assert.equal(validateCard(card), true, JSON.stringify(validateCard.errors));
  assert.deepEqual(card, {
    $schema: MCP_CARD_SCHEMA,
    name: "com.example.docs/docs",
    version: "0.19.0",
    title: "Example",
    description: "Read the Example documentation: get_page and list_pages, no search.",
    websiteUrl: "https://docs.example.com/docs/",
    remotes: [{ type: "streamable-http", url: "https://docs.example.com/docs/mcp" }],
  });
  assert.equal("capabilities" in card, false);
  assert.equal("tools" in card, false);
  assert.match(identity.instructions, /two tools and no search/);
  assert.equal(MCP_CARD_MEDIA_TYPE, "application/mcp-server-card+json");
});

test("the card names the endpoint the site publishes, slashed form included", () => {
  const identity = mcpServerIdentity({
    site: "https://docs.example.com",
    base: "/",
    title: "Example",
    version: "0.19.0",
    endpointUrl: mcpUrl("https://docs.example.com", "/", "always"),
  });
  assert.equal(identity.endpointUrl, "https://docs.example.com/mcp/");
  assert.deepEqual(mcpServerCard(identity).remotes, [{ type: "streamable-http", url: "https://docs.example.com/mcp/" }]);
  assert.equal(mcpCardUrl(identity.endpointUrl), "https://docs.example.com/mcp/server-card");
});

test("a long site title keeps the card's description and title within the schema limits", () => {
  const title = "T".repeat(150);
  const card = mcpServerCard(
    mcpServerIdentity({ site: "https://docs.example.com", base: "/", title, version: "1.0.0" }),
  );
  assert.equal(validateCard(card), true, JSON.stringify(validateCard.errors));
  assert.ok([...card.description].length <= 100);
  assert.ok([...card.title].length <= 100);
});
