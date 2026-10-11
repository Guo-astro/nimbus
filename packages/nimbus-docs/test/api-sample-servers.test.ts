// Where generated samples send requests: the spec's first server, with
// placeholders instead of an invented host; and the Markdown fence for cURL.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildApiModel, getApiPageProps, renderApiPageMarkdown, type ApiOperationPage } from "../src/api/index.js";
import { sampleClientUnavailable, startSampleCapture } from "./_api-sample-wire.js";

async function samples(servers: unknown[] | undefined) {
  const model = await buildApiModel({
    collection: "servers",
    spec: {
      openapi: "3.1.0",
      info: { title: "Servers", version: "1" },
      ...(servers ? { servers } : {}),
      paths: {
        "/zones/{id}": {
          get: {
            operationId: "getZone",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    },
  });
  const page = getApiPageProps(model, "getZone") as ApiOperationPage;
  return { page, curl: page.samples.find((s) => s.lang === "curl")!.source, all: page.samples.map((s) => s.source).join("\n") };
}

describe("sample servers", () => {
  test("no server: <base-url>, never an invented host, in every language", async () => {
    const { curl, all, page } = await samples(undefined);
    assert.match(curl, /--url '<base-url>\/zones\/<id>'/);
    assert.doesNotMatch(all, /api\.example\.com/);
    assert.equal(page.samples.length, 3);
    for (const sample of page.samples) assert.ok(sample.source.includes("<base-url>/zones/<id>"), sample.lang);
  });

  test("a relative server keeps its path after <base-url>", async () => {
    assert.match((await samples([{ url: "/v1" }])).curl, /--url '<base-url>\/v1\/zones\/<id>'/);
    assert.match((await samples([{ url: "v1/" }])).curl, /--url '<base-url>\/v1\/zones\/<id>'/);
  });

  test("server variables use their default, or a placeholder by name", async () => {
    const filled = await samples([{ url: "https://{region}.api.acme.test/{version}", variables: { region: { default: "eu" }, version: { default: "v4" } } }]);
    assert.match(filled.curl, /--url 'https:\/\/eu\.api\.acme\.test\/v4\/zones\/<id>'/);
    const missing = await samples([{ url: "https://{region}.api.acme.test", variables: {} }]);
    assert.match(missing.curl, /--url 'https:\/\/<region>\.api\.acme\.test\/zones\/<id>'/);
    assert.doesNotMatch(filled.all + missing.all, /%7B|https:\/\/\//);
  });

  test("a numeric default fills in, and an unparseable base falls back to <base-url>", async () => {
    assert.match((await samples([{ url: "https://api.acme.test:{port}", variables: { port: { default: 8443 } } }])).curl, /--url 'https:\/\/api\.acme\.test:8443\/zones\/<id>'/);
    const noPort = await samples([{ url: "http://127.0.0.1:{port}/v1", variables: { port: {} } }]);
    assert.equal(noPort.page.samples.length, 3);
    assert.match(noPort.curl, /--url '<base-url>\/zones\/<id>'/);
  });

  test("a server URL's query stays after the path", async () => {
    const { curl, all, page } = await samples([{ url: "https://api.acme.test/v1/?key=1" }]);
    assert.match(curl, /--url 'https:\/\/api\.acme\.test\/v1\/zones\/<id>\?key=1'/);
    for (const sample of page.samples) assert.match(sample.source, /v1\/zones\/<id>/, sample.lang);
    assert.doesNotMatch(all, /key=1\/zones/);
  });

  test("the page still shows the spec's own server", async () => {
    const { page } = await samples([{ url: "https://{region}.api.acme.test", variables: { region: { default: "eu" } } }]);
    assert.equal(page.server, "https://{region}.api.acme.test");
  });

  test("Markdown fences cURL as bash", async () => {
    const md = renderApiPageMarkdown((await samples([{ url: "https://api.acme.test" }])).page);
    assert.match(md, /```bash\ncurl --request GET/);
    assert.doesNotMatch(md, /```curl/);
  });
});

describe("a filled-in default server on the wire", () => {
  let capture: Awaited<ReturnType<typeof startSampleCapture>>;
  before(async () => { capture = await startSampleCapture(); });
  after(async () => { await capture?.close(); });

  test("curl reaches the server the variables describe", { skip: sampleClientUnavailable.curl }, async () => {
    const port = new URL(capture.origin).port;
    const model = await buildApiModel({
      collection: "servers-wire",
      spec: {
        openapi: "3.1.0",
        info: { title: "Servers", version: "1" },
        servers: [{ url: "http://127.0.0.1:{port}/{base}", variables: { port: { default: port }, base: { default: "v4" } } }],
        paths: { "/items": { post: { operationId: "createItem", requestBody: { content: { "application/json": { example: { a: 1 } } } }, responses: { "200": { description: "OK" } } } } },
      },
    });
    const page = getApiPageProps(model, "createItem") as ApiOperationPage;
    const request = await capture.run(page.samples.find((s) => s.lang === "curl")!);
    assert.equal(request.url, "/v4/items");
  });
});
