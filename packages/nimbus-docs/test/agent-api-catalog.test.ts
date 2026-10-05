import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createAgentCapabilities } from "../src/_internal/agent-capabilities.js";
import {
  API_CATALOG_MEDIA_TYPE,
  apiCatalog,
  apiCatalogLink,
} from "../src/_internal/agent-api-catalog.js";
import {
  agentDiscoveryHeaderRules,
  agentDiscoveryManifest,
  agentHomepageLinks,
} from "../src/_internal/agent-discovery.js";

const options = { site: "https://docs.example.com", title: "Example", base: "/docs/" };
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(
  JSON.parse(readFileSync(new URL("./fixtures/api-catalog/linkset.schema.json", import.meta.url), "utf8")),
);
const capabilities = createAgentCapabilities({
  llmsUrl: `${options.site}/docs/llms.txt`,
  apis: [
    {
      collection: "pets",
      docsUrl: `${options.site}/docs/pets/`,
      markdownUrl: `${options.site}/docs/pets/index.md`,
      spec: { url: `${options.site}/docs/pets/openapi.json`, type: "application/vnd.oai.openapi+json" },
    },
    {
      collection: "billing",
      docsUrl: `${options.site}/docs/billing/`,
      markdownUrl: `${options.site}/docs/billing/index.md`,
    },
    {
      collection: "internal",
      docsUrl: `${options.site}/docs/internal/`,
      markdownUrl: `${options.site}/docs/internal/index.md`,
      spec: { url: `${options.site}/docs/internal/openapi.json`, type: "application/vnd.oai.openapi+json" },
      hidden: true,
    },
  ],
});

test("the catalog is a valid linkset, matches the pinned example, and omits hidden versions", () => {
  const catalog = apiCatalog(capabilities)!;
  assert.equal(validate(catalog), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    catalog,
    JSON.parse(readFileSync(new URL("./fixtures/api-catalog/two-apis.json", import.meta.url), "utf8")),
  );
  assert.equal(apiCatalog(createAgentCapabilities({})), undefined);
  assert.equal(API_CATALOG_MEDIA_TYPE, 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"');
  assert.equal(apiCatalogLink(options.site), '<https://docs.example.com/.well-known/api-catalog>; rel="api-catalog"');
});

test("ARD, homepage Link headers and _headers advertise the catalog and published specs only", () => {
  const ard = agentDiscoveryManifest(capabilities, options);
  assert.deepEqual(
    ard.entries.map((entry) => [entry.identifier.split(":").at(-1), entry.type]),
    [["index", "text/plain"], ["api-pets", "application/vnd.oai.openapi+json"]],
  );
  const links = agentHomepageLinks(capabilities, options);
  assert.ok(links.includes('<https://docs.example.com/.well-known/api-catalog>; rel="api-catalog"'));
  assert.equal(links.filter((link) => link.includes('rel="service-doc"')).length, 2);
  assert.deepEqual(
    links.filter((link) => link.includes('rel="service-desc"')),
    ['<https://docs.example.com/docs/pets/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"'],
  );
  const rules = agentDiscoveryHeaderRules(capabilities, options);
  assert.match(
    rules,
    /^\/\.well-known\/api-catalog\n  Content-Type: application\/linkset\+json; profile="https:\/\/www\.rfc-editor\.org\/info\/rfc9727"\n  Access-Control-Allow-Origin: \*\n  Link: <https:\/\/docs\.example\.com\/\.well-known\/api-catalog>; rel="api-catalog"$/m,
  );
  assert.match(rules, /^\/docs\/pets\/openapi\.json\n  Content-Type: application\/vnd\.oai\.openapi\+json/m);
  assert.doesNotMatch(rules, /internal|billing\/openapi/);
  const none = createAgentCapabilities({ llmsUrl: capabilities.llmsUrl });
  assert.doesNotMatch(agentDiscoveryHeaderRules(none, options), /api-catalog/);
  assert.doesNotMatch(agentHomepageLinks(none, options).join(), /api-catalog/);
});

test("the catalog, ARD and Link header code has no spec-format branches", () => {
  for (const file of [
    "../src/_internal/agent-api-catalog.ts",
    "../src/_internal/agent-api-catalog-route.ts",
    "../src/_internal/agent-discovery.ts",
    "../src/_internal/agent-capabilities.ts",
  ]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /openapi/i, file);
  }
});
