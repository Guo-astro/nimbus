import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { dereference } from "@scalar/openapi-parser";
import { parse as parseYaml } from "yaml";
import { OPENAPI_MEDIA_TYPE, publishOpenApiSpec } from "../src/_internal/api/publish-spec.js";

const fixtures = path.resolve(import.meta.dirname, "fixtures/api");

test("a single-file spec publishes as itself", async () => {
  const result = await publishOpenApiSpec("smallco.yaml", fixtures);
  assert.equal(result.error, undefined);
  assert.equal(result.spec!.mediaType, OPENAPI_MEDIA_TYPE);
  assert.deepEqual(JSON.parse(result.spec!.contents), parseYaml(readFileSync(path.join(fixtures, "smallco.yaml"), "utf8")));
  assert.deepEqual(result.spec!.files, [path.join(fixtures, "smallco.yaml")]);
});

test("a multi-file spec publishes as one self-contained document with the pinned shape", async () => {
  const result = await publishOpenApiSpec("multi/openapi.yaml", fixtures);
  assert.equal(result.error, undefined);
  // The shape is the bundler's; pinning it makes a dependency upgrade that
  // changes the published output fail here instead of on a live site.
  assert.equal(result.spec!.contents, readFileSync(path.join(fixtures, "multi/openapi.bundled.json"), "utf8"));
  const document = JSON.parse(result.spec!.contents);
  const resolved = (await dereference(document)) as { errors?: unknown[]; schema: Record<string, never> };
  assert.deepEqual(resolved.errors ?? [], []);
  const pet = resolved.schema.paths["/pets"].get.responses["200"].content["application/json"].schema.items;
  assert.deepEqual(pet.properties.friends.items, pet, "recursion survives bundling");
  assert.deepEqual(resolved.schema.components.schemas.Local, pet);
  assert.deepEqual(
    result.spec!.files.map((file) => path.relative(fixtures, file)).sort(),
    ["multi/openapi.yaml", "multi/paths/owner.yaml", "multi/schemas.yaml"],
  );
});

test("a reference that cannot be bundled is reported by name instead of published", async () => {
  assert.match((await publishOpenApiSpec("unbundlable/openapi.yaml", fixtures)).error ?? "", /missing\.yaml/);
  assert.match((await publishOpenApiSpec("dangling/openapi.yaml", fixtures)).error ?? "", /Nope/);
  assert.match((await publishOpenApiSpec("absent.yaml", fixtures)).error ?? "", /absent\.yaml: file not found/);
  const inline = await publishOpenApiSpec({ openapi: "3.1.0", paths: { "/x": { $ref: "./x.yaml" } } }, fixtures);
  assert.match(inline.error ?? "", /x\.yaml/);
});

test("a missing external JSON pointer is rejected in the serialized publication", async () => {
  const result = await publishOpenApiSpec("dangling-target/openapi.yaml", fixtures);
  assert.match(result.error ?? "", /Nope/);
  assert.equal(result.spec, undefined);
});
