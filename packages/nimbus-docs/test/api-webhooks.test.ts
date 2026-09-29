// Regression: a webhook must assemble the SAME request/response contract as a
// path operation — parameters, request-body fields, and responses — not the
// empty shell it used to emit. A webhook is delivered to the subscriber rather
// than called against a base URL, so it carries NO server and NO synthesised
// `curl` sample; the body/response contract is otherwise identical. Before the
// fix `parseWebhooks` hard-coded empty `auth/request/responses/samples`, so a
// webhook page rendered a bare title with none of its payload.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import {
  buildApiModel,
  getApiPageProps,
  renderApiPageMarkdown,
  type ApiModel,
  type ApiOperationPage,
} from "../src/api/index.js";

let model: ApiModel;

before(async () => {
  model = await buildApiModel({
    collection: "hooks",
    label: "hooks",
    spec: `
openapi: 3.1.0
info: { title: T, version: "1" }
servers:
  - url: https://api.example.com
paths:
  /ping:
    get:
      operationId: ping
      responses:
        "200": { description: ok }
webhooks:
  orderCreated:
    post:
      summary: An order was created
      parameters:
        - name: X-Signature
          in: header
          required: true
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [id]
              properties:
                id: { type: string }
                total: { type: number }
      responses:
        "200":
          description: acknowledged
          content:
            application/json:
              schema:
                type: object
                properties:
                  received: { type: boolean }
`,
  });
});

describe("a webhook assembles the full request/response contract", () => {
  const hook = () => getApiPageProps(model, "orderCreated") as ApiOperationPage;

  test("it is flagged as a webhook and routes under webhooks/", () => {
    const page = hook();
    assert.equal(page.kind, "operation");
    assert.equal(page.isWebhook, true);
    assert.equal(page.href, "/hooks/webhooks/orderCreated/");
  });

  test("its parameters are minted (not the old empty shell)", () => {
    const names = hook().parameters.flatMap((g) => g.fields.map((f) => f.name));
    assert.deepEqual(names, ["X-Signature"]);
  });

  test("its request-body fields are minted", () => {
    const fields = hook().body.map((f) => f.name).sort();
    assert.deepEqual(fields, ["id", "total"]);
    assert.equal(hook().body.find((f) => f.name === "id")!.required, true);
  });

  test("its responses are minted with their fields", () => {
    const responses = hook().responses;
    assert.deepEqual(responses.map((r) => r.status), ["200"]);
    assert.ok(
      responses[0].fields.some((f) => f.name === "received"),
      "the 200 response body field survives",
    );
  });

  test("a webhook carries no server and no synthesised sample", () => {
    const page = hook();
    assert.equal(page.server, undefined, "delivered, not called — no base URL");
    assert.equal(page.samples.length, 0, "no curl for a server-to-client delivery");
  });

  test("the payload survives into the rendered Markdown version", () => {
    const md = renderApiPageMarkdown(hook());
    assert.ok(md.includes("orderCreated.id"), "the body field row is emitted");
  });
});
