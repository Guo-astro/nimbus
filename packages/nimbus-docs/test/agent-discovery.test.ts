import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createAgentCapabilities } from "../src/_internal/agent-capabilities.js";
import {
  agentDiscoveryManifest,
  agentHomepageLinks,
  agentDiscoveryHeaderRules,
  appendAgentDiscoveryHeaders,
} from "../src/_internal/agent-discovery.js";

const options = {
  site: "https://docs.example.com",
  title: "Example",
  base: "/docs/",
};
const minimal = createAgentCapabilities({
  llmsUrl: `${options.site}/docs/llms.txt`,
  homepageMarkdownUrl: `${options.site}/docs/index.md`,
});
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const schema = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `./fixtures/agent-discovery/${name}.schema.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const ard = schema("ard-entry");
ajv.addSchema(ard);
const validateArd = ajv.compile({ $ref: `${ard.$id}#/$defs/ArdManifest` });
const validateCatalog = ajv.compile(schema("ai-catalog"));

test("minimal discovery validates against both pinned schemas and matches the fixture", () => {
  const document = agentDiscoveryManifest(minimal, options);
  for (const validate of [validateArd, validateCatalog])
    assert.equal(validate(document), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    document,
    JSON.parse(
      readFileSync(
        new URL("./fixtures/agent-discovery/docs-only.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(
    document.entries.map((entry) => entry.type),
    ["text/plain", "text/markdown"],
  );
  assert.equal(agentHomepageLinks(minimal, options).length, 3);
});

test("discovery and API documentation links exclude hidden collections", () => {
  const capabilities = createAgentCapabilities({
    llmsUrl: minimal.llmsUrl,
    homepageMarkdownUrl: minimal.homepageMarkdownUrl,
    apis: [
      { collection: "pets", docsUrl: `${options.site}/docs/pets/` },
      {
        collection: "private",
        docsUrl: `${options.site}/private/`,
        hidden: true,
      },
    ],
  });
  assert.equal(agentDiscoveryManifest(capabilities, options).entries.length, 2);
  const links = agentHomepageLinks(capabilities, options).join(", ");
  assert.match(links, /service-doc/);
  assert.doesNotMatch(links, /service-desc|api-catalog|private/);
  assert.doesNotMatch(
    JSON.stringify(agentDiscoveryManifest(capabilities, options)),
    /mcp|skills|private/,
  );
});

test("discovery identifiers distinguish base paths and normalize trailing slashes", () => {
  const document = agentDiscoveryManifest(minimal, options);
  const normalised = agentDiscoveryManifest(minimal, {
    ...options,
    base: "/docs",
  });
  const other = agentDiscoveryManifest(minimal, {
    ...options,
    base: "/handbook",
  });
  assert.deepEqual(document.entries, normalised.entries);
  assert.notEqual(
    document.entries[0]?.identifier,
    other.entries[0]?.identifier,
  );
});

test("header generation preserves owner bytes and applies only to bounded exact paths", () => {
  const owner =
    "/custom\n  Cache-Control: private\n/\n  Link: <https://example.net/>; rel=help";
  const generated = agentDiscoveryHeaderRules(minimal, options);
  assert.ok(
    appendAgentDiscoveryHeaders(owner, generated).startsWith(owner + "\n\n"),
  );
  assert.match(generated, /^\/docs\/\n  Link: /m);
  assert.match(generated, /^\/docs\n  Link: /m);
  assert.match(
    generated,
    /^\/\.well-known\/ard.json\n  Content-Type: application\/json\n  Access-Control-Allow-Origin: \*/m,
  );
  assert.match(
    generated,
    /^\/docs\/index.md\n  Content-Type: text\/markdown; charset=utf-8/m,
  );
  assert.equal((generated.match(/rel="ard"/g) ?? []).length, 2);
});

test("homepage Markdown remains addressable but noindex removes its discovery links", () => {
  const capabilities = { ...minimal, homepageDiscoverable: false };
  assert.deepEqual(
    agentDiscoveryManifest(capabilities, options).entries.map(
      (entry) => entry.type,
    ),
    ["text/plain"],
  );
  assert.doesNotMatch(
    agentHomepageLinks(capabilities, options).join(", "),
    /alternate|index.md/,
  );
  assert.match(
    agentDiscoveryHeaderRules(capabilities, options),
    /index.md\n  Content-Type/,
  );
});

test("regenerating headers does not duplicate Nimbus's block or lose owner lines", () => {
  const generated = agentDiscoveryHeaderRules(minimal, options);
  for (const owner of [
    "",
    "/custom\n  X-Owner: yes",
    "/custom\n  X-Owner: yes\n",
  ]) {
    const once = appendAgentDiscoveryHeaders(owner, generated);
    assert.equal(appendAgentDiscoveryHeaders(once, generated), once);
    assert.ok(once.startsWith(owner));
  }
});

test("discovery headers share existing exact-path rules without replacing owner fields", () => {
  for (const base of ["/", "/docs"]) {
    for (const newline of ["\n", "\r\n"]) {
      const home = base === "/" ? "/" : "/docs/";
      const owner = [
        "# Owner policy",
        "/*",
        "  X-Global: retained",
        home,
        '  Link: <https://owner.example/policy>; rel="author"',
        "  X-Owner: retained",
        "",
        "/custom",
        "  Cache-Control: private",
        "",
      ].join(newline);
      const settings = { ...options, base };
      const generated = agentDiscoveryHeaderRules(minimal, settings);
      const merged = appendAgentDiscoveryHeaders(owner, generated);
      const paths = merged.split(/\r?\n/).filter((line) => line === home);
      assert.equal(paths.length, 1);
      const block = merged.slice(merged.indexOf(`${home}${newline}`), merged.indexOf("/custom"));
      assert.match(block, /rel="author"/);
      assert.match(block, /rel="ard"/);
      assert.match(block, /X-Owner: retained/);
      assert.match(merged, /X-Global: retained/);
      assert.match(merged, /Cache-Control: private/);
      assert.equal(appendAgentDiscoveryHeaders(merged, generated), merged);
      const updated = appendAgentDiscoveryHeaders(
        merged,
        agentDiscoveryHeaderRules({ ...minimal, homepageDiscoverable: false }, settings),
      );
      assert.match(updated, /rel="author"/);
      assert.doesNotMatch(updated, /rel="alternate"/);
      assert.equal(updated.split(/\r?\n/).filter((line) => line === home).length, 1);
    }
  }
});

test("many API versions get separate bounded Link lines with unchanged header values", () => {
  const capabilities = createAgentCapabilities({
    ...minimal,
    apis: Array.from({ length: 30 }, (_, version) => ({
      collection: "pets",
      version: `v${version}`,
      docsUrl: `${options.site}/docs/pets/v${version}/`,
    })),
  });
  const values = agentHomepageLinks(capabilities, options);
  assert.ok(
    values.join(", ").length > 2000,
    "fixture must exceed the old line limit",
  );
  const block = agentDiscoveryHeaderRules(capabilities, options)
    .split("\n\n")
    .find((rule) => rule.startsWith("/docs/\n"))!;
  const lines = block.split("\n").slice(1);
  assert.equal(lines.length, values.length);
  assert.ok(lines.every((line) => line.length <= 2000));
  const served = new Headers();
  for (const line of lines) {
    assert.ok(line.startsWith("  Link: "));
    served.append("Link", line.slice("  Link: ".length));
  }
  assert.equal(served.get("Link"), values.join(", "));
});

test("base namespaces escape once, retain segment identity, and validate against both schemas", () => {
  const cases = [
    ["/", "docs"],
    ["/docs", "docs-docs"],
    ["/my docs/v2", "docs-my_20docs-v2"],
    ["/my%20docs/v2", "docs-my_20docs-v2"],
    ["/a/b", "docs-a-b"],
    ["/a-b", "docs-a_2Db"],
    ["/a_2Db", "docs-a_5F2Db"],
    ["/a%2Fb", "docs-a_2Fb"],
    ["/café", "docs-caf_C3_A9"],
    ["/a//b", "docs-a--b"],
  ];
  for (const [base, namespace] of cases) {
    const document = agentDiscoveryManifest(minimal, {
      ...options,
      base: base!,
    });
    assert.equal(
      document.entries[0]?.identifier,
      `urn:air:docs.example.com:${namespace}:index`,
    );
    for (const validate of [validateArd, validateCatalog])
      assert.equal(
        validate(document),
        true,
        `${base}: ${JSON.stringify(validate.errors)}`,
      );
  }
});

test("browser search capabilities follow the provider and exclude hidden versions", () => {
  assert.equal(createAgentCapabilities({}).search, "pagefind");
  assert.equal(
    createAgentCapabilities({ search: { provider: "pagefind" } }).search,
    "pagefind",
  );
  assert.equal(
    createAgentCapabilities({ search: false }).search,
    "unavailable",
  );
  assert.equal(
    createAgentCapabilities({ search: { provider: "custom" } }).search,
    "unavailable",
  );
  assert.deepEqual(
    createAgentCapabilities({
      versions: [
        { name: "current" },
        { name: "old" },
        { name: "private", hidden: true },
        { name: "current" },
      ],
    }).versions,
    ["current", "old"],
  );
});
