import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build, dev } from "astro";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";

const fixtures = path.resolve(import.meta.dirname, "fixtures/api");
const runtime = pathToFileURL(path.resolve(import.meta.dirname, "../src/runtime.ts")).href;
const apiSite = (api: unknown[], collections: string[]) =>
  fixture(undefined, "docs", { collections, api });
async function pages(site: Awaited<ReturnType<typeof fixture>>, collections: string[]) {
  for (const collection of collections)
    await site.write(
      `src/pages/${collection}/[...slug].astro`,
      `---\nimport { getApiStaticPaths } from ${JSON.stringify(runtime)};\nexport const prerender = true;\nexport const getStaticPaths = getApiStaticPaths(${JSON.stringify(collection)});\n---\n<html><body>${collection}</body></html>`,
    );
}
const CATALOG_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

test("a real build publishes specs at their mount paths, a catalog without hidden versions, and warns about an unbundlable spec", async () => {
  const site = await apiSite(
    [
      {
        collection: "pets",
        versions: [
          { version: "v2", spec: path.join(fixtures, "multi/openapi.yaml"), default: true },
          { version: "v1", spec: path.join(fixtures, "smallco.yaml"), hidden: true },
        ],
      },
      { collection: "things", spec: path.join(fixtures, "unbundlable/openapi.yaml") },
      { collection: "billing", spec: path.join(fixtures, "smallco.yaml"), publishSpec: false },
    ],
    ["pets", "things", "billing"],
  );
  await pages(site, ["pets", "things", "billing"]);
  const output: string[] = [];
  const restore = [process.stdout, process.stderr].map((stream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array) => (output.push(String(chunk)), true)) as typeof stream.write;
    return () => (stream.write = original);
  });
  try {
    await build({ ...site.config, logLevel: "warn" });
    const published = JSON.parse(await site.read("dist/pets/openapi.json"));
    assert.equal(published.info.title, "Multi-file API");
    assert.doesNotMatch(JSON.stringify(published), /"\$ref":"[^#]/, "published spec is self-contained");
    // Hidden versions still publish their file, just not their discovery.
    assert.equal(JSON.parse(await site.read("dist/pets/v1/openapi.json")).info.title, "SmallCo API");
    await assert.rejects(site.read("dist/things/openapi.json"));
    await assert.rejects(site.read("dist/billing/openapi.json"));
    assert.match(output.join(""), /not publishing the spec for "things": .*missing\.yaml/);
    const catalog = JSON.parse(await site.read("dist/.well-known/api-catalog"));
    assert.deepEqual(
      catalog.linkset.map((entry: { anchor: string; "service-desc"?: unknown[] }) => [
        entry.anchor,
        entry["service-desc"]?.length ?? 0,
      ]),
      [
        ["https://example.test/docs/pets/", 1],
        ["https://example.test/docs/things/", 0],
        ["https://example.test/docs/billing/", 0],
      ],
    );
    assert.doesNotMatch(JSON.stringify(catalog), /v1/);
    const ard = JSON.parse(await site.read("dist/.well-known/ard.json"));
    assert.deepEqual(
      ard.entries.filter((entry: { url: string }) => entry.url.endsWith("openapi.json")).map((entry: { url: string }) => entry.url),
      ["https://example.test/docs/pets/openapi.json"],
    );
    const headers = await site.read("dist/_headers");
    assert.ok(headers.includes(`/.well-known/api-catalog\n  Content-Type: ${CATALOG_TYPE}\n  Access-Control-Allow-Origin: *`), headers);
    assert.match(headers, /Link: <https:\/\/example\.test\/\.well-known\/api-catalog>; rel="api-catalog"/);
    assert.match(headers, /^\/docs\/pets\/openapi\.json\n  Content-Type: application\/vnd\.oai\.openapi\+json/m);
    // Hidden versions publish their file with its media type but no discovery link.
    assert.match(headers, /^\/docs\/pets\/v1\/openapi\.json\n  Content-Type: application\/vnd\.oai\.openapi\+json/m);
    assert.doesNotMatch(headers, /v1\/openapi\.json>|things\/openapi|billing\/openapi/);
    assert.equal((headers.match(/rel="service-desc"/g) ?? []).length, 2);
  } finally {
    for (const r of restore) r();
    await rm(site.root, { recursive: true, force: true });
  }
});

test("every collection opted out still yields a catalog with documentation links only", async () => {
  const site = await apiSite(
    [{ collection: "pets", spec: path.join(fixtures, "smallco.yaml"), publishSpec: false, versions: undefined }],
    ["pets"],
  );
  await pages(site, ["pets"]);
  try {
    await build(site.config);
    const catalog = JSON.parse(await site.read("dist/.well-known/api-catalog"));
    assert.equal(catalog.linkset.length, 1);
    assert.equal(catalog.linkset[0]["service-desc"], undefined);
    assert.equal(catalog.linkset[0]["service-doc"].length, 2);
    await assert.rejects(site.read("dist/pets/openapi.json"));
    const headers = await site.read("dist/_headers");
    assert.match(headers, /rel="api-catalog"/);
    assert.match(headers, /rel="service-doc"/);
    assert.doesNotMatch(headers, /service-desc|openapi\.json/);
    assert.doesNotMatch(await site.read("dist/.well-known/ard.json"), /openapi\.json/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("a version-level publishSpec overrides the collection and a site without APIs has no catalog", async () => {
  const site = await apiSite(
    [
      {
        collection: "pets",
        publishSpec: false,
        versions: [
          { version: "v2", spec: path.join(fixtures, "smallco.yaml"), default: true },
          { version: "v1", spec: path.join(fixtures, "smallco.yaml"), publishSpec: true },
        ],
      },
    ],
    ["pets"],
  );
  await pages(site, ["pets"]);
  try {
    await build(site.config);
    await assert.rejects(site.read("dist/pets/openapi.json"));
    assert.ok(await site.read("dist/pets/v1/openapi.json"));
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
  const plain = await fixture();
  try {
    await build(plain.config);
    await assert.rejects(plain.read("dist/.well-known/api-catalog"));
    assert.doesNotMatch(await plain.read("dist/_headers"), /api-catalog/);
  } finally {
    await rm(plain.root, { recursive: true, force: true });
  }
});

test("the dev server serves the catalog, specs, discovery, and skills together with GET and HEAD", async () => {
  const site = await apiSite([{ collection: "pets", spec: path.join(fixtures, "multi/openapi.yaml") }], ["pets"]);
  await pages(site, ["pets"]);
  await site.write(
    "skills/catalog-helper/SKILL.md",
    "---\nname: catalog-helper\ndescription: Read the API catalog.\n---\n# Catalog\n",
  );
  const server = await dev({ ...site.config, server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${origin}/.well-known/api-catalog`, { method });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("Content-Type"), CATALOG_TYPE);
      assert.equal(response.headers.get("Link"), '<https://example.test/.well-known/api-catalog>; rel="api-catalog"');
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
      if (method === "GET") assert.equal((await response.json()).linkset[0].anchor, "https://example.test/docs/pets/");
      else assert.equal(await response.text(), "");
      for (const [pathname, type] of [
        ["/.well-known/ard.json", "application/json"],
        ["/.well-known/ai-catalog.json", "application/json"],
        ["/.well-known/agent-skills/index.json", "application/json"],
        ["/.well-known/agent-skills/catalog-helper/SKILL.md", "text/markdown"],
        ["/docs/pets/openapi.json", "application/vnd.oai.openapi+json"],
      ]) {
        const resource = await fetch(origin + pathname, { method });
        assert.equal(resource.status, 200, pathname);
        assert.ok(resource.headers.get("Content-Type")?.includes(type), pathname);
        if (method === "HEAD") assert.equal(await resource.text(), "");
        else if (pathname === "/.well-known/ard.json") {
          const urls = (await resource.json()).entries.map((entry: { url: string }) => entry.url);
          assert.ok(urls.includes("https://example.test/docs/pets/openapi.json"));
          assert.ok(urls.includes("https://example.test/.well-known/agent-skills/index.json"));
        }
      }
    }
    const spec = await fetch(`${origin}/docs/pets/openapi.json`);
    assert.equal(spec.status, 200);
    assert.equal(spec.headers.get("Content-Type"), "application/vnd.oai.openapi+json");
    assert.equal((await spec.json()).info.title, "Multi-file API");
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});
