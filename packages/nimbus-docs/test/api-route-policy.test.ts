// The `resource-action-v1` route convention. Each acceptance criterion in the route
// convention design doc is pinned here: normalization is byte-frozen, derivation
// follows the two grammars + action table, prefixes strip before classification,
// the identity/route split lets a route-hostile operationId build under resource-action-v1
// while legacy rejects it, overrides win and unused keys fail, collisions and
// reserved routes fail, and cross-version drift warns without gating. The three
// frozen golden inputs and the whole strip→classify→project→fallback pipeline
// live in `route-policy.ts`; the mint-time integration lives in `operations.ts`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  normalizeResourceActionSegment,
  deriveResourceActionV1,
  stripPrefixes,
  resolveOperationRoute,
  routeSlugFault,
  prefixEntryFault,
  type RoutePolicy,
} from "../src/_internal/api/route-policy.js";
import {
  buildApiModel,
  getApiPageSlugs,
  getApiRouteProvenance,
  type ApiModel,
} from "../src/api/index.js";
import { parseOpenApi } from "../src/_internal/api/parse.js";
import { apiCollection } from "../src/content.js";
import { validateNimbusConfig } from "../src/_internal/validate.js";
import type { ApiVersionSpec } from "../src/types.js";

const RESOURCE_ACTION_V1: RoutePolicy = { convention: "resource-action-v1", stripPathPrefixes: ["/v1"] };

// ── helpers ───────────────────────────────────────────────────────────────

type PathItem = Record<string, unknown>;

function spec(paths: Record<string, PathItem>): Record<string, unknown> {
  return { openapi: "3.0.0", info: { title: "T", version: "1.0.0" }, paths };
}

const OK = { responses: { "200": { description: "ok" } } };
const ID_PARAM = { name: "id", in: "path", required: true, schema: { type: "string" } };
function member(extra: PathItem): PathItem {
  return { parameters: [ID_PARAM], ...extra };
}

async function slugsOf(
  collection: string,
  paths: Record<string, PathItem>,
  routes: RoutePolicy | undefined = RESOURCE_ACTION_V1,
): Promise<Map<string, string>> {
  const model = await buildApiModel({ collection, spec: spec(paths), routes });
  return new Map(getApiPageSlugs(model).map(({ coordinate, slug }) => [coordinate, slug]));
}

// `buildApiModel` throws on errors but discards warnings; the raw parse exposes
// both, so warning-level behavior (missing-operation-id, route-fallback) is
// asserted here against `diagnostics`, and slug/provenance read off the model.
async function parseWith(
  collection: string,
  paths: Record<string, PathItem>,
  extra: Partial<Parameters<typeof parseOpenApi>[0]> = {},
) {
  const { model, diagnostics } = await parseOpenApi({
    collection,
    spec: spec(paths),
    routes: RESOURCE_ACTION_V1,
    ...extra,
  });
  const slugs = model.pages.slugs;
  const provenance = model.pages.provenance ?? new Map();
  const slugOf = (needle: string): string | undefined =>
    [...slugs.values()].find((s) => s === needle);
  return { diagnostics, slugs, provenance, slugOf };
}

// ── normalization (frozen) ──────────────────────────────────────────────────

describe("normalizeResourceActionSegment — frozen golden cases", () => {
  const golden: Array<[string, string]> = [
    ["HTTPSRequest", "https-request"],
    ["openDispute", "open-dispute"],
    ["OAuth2Token", "o-auth2-token"],
    ["HTMLToJSON", "html-to-json"],
    ["S3ACL", "s3-acl"],
  ];
  for (const [input, output] of golden) {
    test(`${input} → ${output}`, () => {
      assert.equal(normalizeResourceActionSegment(input), output);
    });
  }
  test("a separators-only segment normalizes to empty", () => {
    assert.equal(normalizeResourceActionSegment("___"), "");
  });
});

// ── prefix stripping ────────────────────────────────────────────────────────

describe("stripPrefixes — whole-segment, longest-match, order-independent", () => {
  test("strips a matching prefix on whole segments only", () => {
    assert.deepEqual(stripPrefixes("/v1/charges", ["/v1"]), ["charges"]);
    assert.deepEqual(stripPrefixes("/v1beta/accounts", ["/v1"]), ["v1beta", "accounts"]);
  });
  test("longest match wins regardless of config order", () => {
    assert.deepEqual(stripPrefixes("/v1/beta/x", ["/v1", "/v1/beta"]), ["x"]);
    assert.deepEqual(stripPrefixes("/v1/beta/x", ["/v1/beta", "/v1"]), ["x"]);
  });
  test("leading/trailing slashes on the prefix are ignored; matching is case-sensitive", () => {
    assert.deepEqual(stripPrefixes("/v1/x", ["v1/"]), ["x"]);
    assert.deepEqual(stripPrefixes("/V1/x", ["/v1"]), ["V1", "x"]);
  });
  test("a path equal to a prefix leaves an empty resource path", () => {
    assert.deepEqual(stripPrefixes("/v1", ["/v1"]), []);
  });
});

// ── derivation ──────────────────────────────────────────────────────────────

describe("deriveResourceActionV1 — the two grammars and the action table", () => {
  const cases: Array<[string, string, string, string | null]> = [
    ["GET", "/v1/charges", "collection list", "charges/list"],
    ["POST", "/v1/charges", "collection create", "charges/create"],
    ["GET", "/v1/charges/{id}", "member retrieve", "charges/retrieve"],
    ["PUT", "/v1/charges/{id}", "member update (PUT)", "charges/update"],
    ["PATCH", "/v1/charges/{id}", "member update (PATCH)", "charges/update"],
    ["DELETE", "/v1/charges/{id}", "member delete", "charges/delete"],
    ["POST", "/v1/charges/{id}", "POST to a member — no action mapping", null],
    ["POST", "/v1/charges/{id}/capture", "action after a param — neither grammar", null],
    ["POST", "/v1/rpc/doThing", "two static segments — neither grammar", null],
    ["GET", "/v1/{id}", "bare parameter, no static resource", null],
  ];
  for (const [method, path, name, expected] of cases) {
    test(`${method} ${path} — ${name}`, () => {
      assert.equal(deriveResourceActionV1(method, path, ["/v1"]), expected);
    });
  }

  test("a resource that normalizes to empty does not derive (falls back)", () => {
    assert.equal(deriveResourceActionV1("GET", "/v1/___", ["/v1"]), null);
  });

  test("a malformed path (trailing or interior slash) does not derive", () => {
    // A trailing `/` or interior `//` matches neither exact grammar, so it falls
    // back rather than aliasing the clean shape (`/charges` vs `/charges/`).
    assert.equal(deriveResourceActionV1("GET", "/v1/charges/", ["/v1"]), null);
    assert.equal(deriveResourceActionV1("GET", "/v1//charges", ["/v1"]), null);
    assert.equal(deriveResourceActionV1("GET", "//charges", undefined), null);
    assert.equal(deriveResourceActionV1("GET", "/", undefined), null);
    // The clean counterpart still derives, proving the malformed variants aliased it.
    assert.equal(deriveResourceActionV1("GET", "/v1/charges", ["/v1"]), "charges/list");
  });

  test("a path without a leading slash is not a well-formed absolute path", () => {
    assert.equal(deriveResourceActionV1("GET", "charges", undefined), null);
    assert.equal(deriveResourceActionV1("GET", "v1/charges", ["/v1"]), null);
    assert.equal(deriveResourceActionV1("PUT", "items/{id}", undefined), null);
    assert.equal(deriveResourceActionV1("GET", "/charges", undefined), "charges/list");
  });

  test("a malformed or compound parameter is not a member parameter", () => {
    // `{}`/`{{id}}`/`{id}{format}` are not single `{name}` tokens, so the member
    // grammar does not match and the path falls back — never a bogus member route.
    assert.equal(deriveResourceActionV1("GET", "/v1/charges/{}", ["/v1"]), null);
    assert.equal(deriveResourceActionV1("GET", "/v1/charges/{{id}}", ["/v1"]), null);
    assert.equal(deriveResourceActionV1("GET", "/v1/charges/{id}{format}", ["/v1"]), null);
    // A brace-bearing lone segment is not a static resource either.
    assert.equal(deriveResourceActionV1("GET", "/v1/{id}{format}", ["/v1"]), null);
  });

  test("syntactic-but-ambiguous singletons still infer (semantics are the author's job)", () => {
    assert.equal(deriveResourceActionV1("GET", "/account", undefined), "account/list");
    assert.equal(deriveResourceActionV1("GET", "/search", undefined), "search/list");
    assert.equal(deriveResourceActionV1("PUT", "/items/{id}", undefined), "items/update");
  });
});

describe("resolveOperationRoute — override → derivation → fallback", () => {
  test("an override wins and is reported as override", () => {
    const outcome = resolveOperationRoute(
      { convention: "resource-action-v1", operations: { Foo: "a/b" } },
      { method: "POST", path: "/anything", operationId: "Foo", coordinate: "Foo" },
    );
    assert.deepEqual(outcome, { kind: "override", slug: "a/b" });
  });
  test("a non-empty coordinate leaf is a warning-level fallback", () => {
    const outcome = resolveOperationRoute(RESOURCE_ACTION_V1, {
      method: "POST",
      path: "/v1/rpc/doThing",
      operationId: "doThing",
      coordinate: "doThing",
    });
    assert.deepEqual(outcome, { kind: "fallback", slug: "do-thing" });
  });
  test("a coordinate that normalizes away is the fatal empty fallback", () => {
    const outcome = resolveOperationRoute(RESOURCE_ACTION_V1, {
      method: "POST",
      path: "/v1/rpc/x",
      operationId: "___",
      coordinate: "___",
    });
    assert.deepEqual(outcome, { kind: "fallback-empty" });
  });
});

// ── mint-time integration ───────────────────────────────────────────────────

describe("resource-action-v1 minting — derivation, prefixes, fallback", () => {
  test("classifies before dropping parameters; both charges ops share the resource", async () => {
    const slugs = await slugsOf("rp-derive", {
      "/v1/charges": { get: { operationId: "listCharges", ...OK }, post: { operationId: "createCharge", ...OK } },
      "/v1/charges/{id}": member({
        get: { operationId: "getCharge", ...OK },
        put: { operationId: "updateCharge", ...OK },
        delete: { operationId: "deleteCharge", ...OK },
      }),
    });
    assert.equal(slugs.get("listCharges"), "charges/list");
    assert.equal(slugs.get("createCharge"), "charges/create");
    assert.equal(slugs.get("getCharge"), "charges/retrieve");
    assert.equal(slugs.get("updateCharge"), "charges/update");
    assert.equal(slugs.get("deleteCharge"), "charges/delete");
  });

  test("non-inferring shapes fall back to the normalized coordinate leaf (build still succeeds)", async () => {
    const slugs = await slugsOf("rp-fallback", {
      "/v1/charges/{id}/capture": member({ post: { operationId: "captureCharge", ...OK } }),
      "/v1/rpc/doThing": { post: { operationId: "doThing", ...OK } },
    });
    assert.equal(slugs.get("captureCharge"), "capture-charge");
    assert.equal(slugs.get("doThing"), "do-thing");
  });

  test("tags never affect a resource-action-v1 slug", async () => {
    const tagged = await slugsOf("rp-tag-a", {
      "/v1/charges": { get: { operationId: "listCharges", tags: ["Billing"], ...OK } },
    });
    const untagged = await slugsOf("rp-tag-b", {
      "/v1/charges": { get: { operationId: "listCharges", ...OK } },
    });
    assert.equal(tagged.get("listCharges"), "charges/list");
    assert.equal(untagged.get("listCharges"), "charges/list");
  });

  test("tags never affect a fallback slug either", async () => {
    // The fallback path (normalized coordinate leaf) is tag-invariant too, not
    // just derivation — a tag never prefixes or moves a resource-action-v1 route.
    const tagged = await slugsOf("rp-fb-tag-a", {
      "/v1/rpc/doThing": { post: { operationId: "doThing", tags: ["Billing"], ...OK } },
    });
    const untagged = await slugsOf("rp-fb-tag-b", {
      "/v1/rpc/doThing": { post: { operationId: "doThing", ...OK } },
    });
    assert.equal(tagged.get("doThing"), "do-thing");
    assert.equal(untagged.get("doThing"), "do-thing");
  });

  test("the empty fallback leaf is fatal with an override-required diagnostic", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-empty",
          spec: spec({ "/v1/rpc/x": { post: { operationId: "___", ...OK } } }),
          routes: RESOURCE_ACTION_V1,
        }),
      /normalizes to an empty slug|routes\.operations/i,
    );
  });
});

describe("resource-action-v1 overrides", () => {
  test("an override bypasses derivation", async () => {
    const slugs = await slugsOf("rp-ovr", {
      "/v1/charges/{id}/dispute/close": member({ post: { operationId: "closeDispute", ...OK } }),
    }, { convention: "resource-action-v1", stripPathPrefixes: ["/v1"], operations: { closeDispute: "charges/dispute/close" } });
    assert.equal(slugs.get("closeDispute"), "charges/dispute/close");
  });

  test("an override key that matches no operation fails the build, naming it", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-ovr-unused",
          spec: spec({ "/v1/charges": { get: { operationId: "listCharges", ...OK } } }),
          routes: { convention: "resource-action-v1", stripPathPrefixes: ["/v1"], operations: { typoId: "x/y" } },
        }),
      /typoId.*does not match any operation/is,
    );
  });

  test("an override keyed by a real webhook operationId is named as a webhook, not a typo", async () => {
    // The unused-override check runs after webhooks are parsed, so a webhook's
    // operationId is recognized: it exists, but webhooks route by their map key
    // and cannot be retargeted — so the diagnostic says exactly that. The webhook
    // here is multi-method and the override keys the NON-paged method's id
    // (`get` is paged first, `post` is not), so this also guards the two-loop that
    // records every method's id independent of the single-page `break`.
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-ovr-webhook",
          spec: {
            openapi: "3.1.0",
            info: { title: "T", version: "1.0.0" },
            paths: { "/v1/charges": { get: { operationId: "listCharges", ...OK } } },
            webhooks: {
              "charge.succeeded": {
                get: { operationId: "onChargeGet", ...OK },
                post: { operationId: "onChargeSucceeded", ...OK },
              },
            },
          },
          routes: { convention: "resource-action-v1", stripPathPrefixes: ["/v1"], operations: { onChargeSucceeded: "x/y" } },
        }),
      (err: Error) => {
        assert.match(err.message, /onChargeSucceeded/);
        assert.match(err.message, /webhook/i);
        // The page is keyed by the webhook map key, not the operationId.
        assert.match(err.message, /webhooks\/charge\.succeeded/);
        assert.doesNotMatch(err.message, /does not match any operation/);
        return true;
      },
    );
  });

  test("an override keyed by an operationId shared by a webhook and a path op is still rejected", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-shared-id",
          spec: {
            openapi: "3.1.0",
            info: { title: "T", version: "1.0.0" },
            paths: { "/v1/charges": { get: { operationId: "shared", ...OK } } },
            webhooks: { "charge.succeeded": { post: { operationId: "shared", ...OK } } },
          },
          routes: { convention: "resource-action-v1", stripPathPrefixes: ["/v1"], operations: { shared: "x/y" } },
        }),
      (err: Error) => {
        assert.match(err.message, /"shared"/);
        assert.match(err.message, /webhook/i);
        assert.match(err.message, /unique/i);
        return true;
      },
    );
  });
});

describe("identity / route split", () => {
  test("a route-hostile operationId builds under resource-action-v1 (opaque coordinate) …", async () => {
    const slugs = await slugsOf("rp-split-ok", {
      "/v1/widgets": { post: { operationId: "Create Widget", ...OK } },
    });
    // The space-bearing id is retained as the coordinate; the slug is derived.
    assert.equal(slugs.get("Create Widget"), "widgets/create");
  });

  test("… while the same operationId is rejected under legacy routing", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-split-legacy",
          spec: spec({ "/v1/widgets": { post: { operationId: "Create Widget", ...OK } } }),
          // no routes → legacy: the operationId becomes the slug and is route-checked.
        }),
      /whitespace|unsafe as a URL/i,
    );
  });
});

describe("collision & reserved-route safety", () => {
  test("a derivation collision (PUT + PATCH → update) fails, naming how each resolved", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-collide",
          spec: spec({
            "/v1/items/{id}": member({
              put: { operationId: "putItem", ...OK },
              patch: { operationId: "patchItem", ...OK },
            }),
          }),
          routes: RESOURCE_ACTION_V1,
        }),
      (err: Error) => {
        assert.match(err.message, /route slug "items\/update"/);
        assert.match(err.message, /resolved via derived/);
        // A derived slug can't be changed by renaming — the fix is an override.
        assert.match(err.message, /routes\.operations` override/);
        assert.doesNotMatch(err.message, /Rename one operation, schema, tag/);
        return true;
      },
    );
  });

  test("a legacy (identity-routed) slug collision still recommends renaming", async () => {
    // No policy → neither side is derived/fallback, so the advice stays "Rename"
    // (the slug IS the identity, so renaming actually changes it). A tagged op
    // (`billing/list`) collides with an untagged op whose id is `billing/list`.
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-legacy-collide",
          spec: spec({
            "/a": { get: { operationId: "list", tags: ["billing"], ...OK } },
            "/b": { get: { operationId: "billing/list", ...OK } },
          }),
          // no `routes` → legacy identity routing
        }),
      (err: Error) => {
        assert.match(err.message, /both map to the\s+route slug "billing\/list"/);
        assert.match(err.message, /Rename one operation, schema, tag, or webhook/);
        assert.doesNotMatch(err.message, /routes\.operations` override/);
        return true;
      },
    );
  });

  test("two overrides onto the same slug recommend retargeting the override, not renaming", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-ovr-collide",
          spec: spec({
            "/a": { get: { operationId: "getA", ...OK } },
            "/b": { get: { operationId: "getB", ...OK } },
          }),
          routes: {
            convention: "resource-action-v1",
            operations: { getA: "billing/summary", getB: "billing/summary" },
          },
        }),
      (err: Error) => {
        assert.match(err.message, /route slug "billing\/summary"/);
        assert.match(err.message, /resolved via override/);
        assert.match(err.message, /Adjust the `routes\.operations` override target/);
        assert.doesNotMatch(err.message, /Rename one operation, schema, tag/);
        return true;
      },
    );
  });

  test("two fallback slugs colliding recommend renaming (a fallback slug IS the coordinate)", async () => {
    // A POST to a deep path does not derive, so both fall back to their
    // normalized coordinate — and `do.thing`/`do-thing` both normalize to `do-thing`.
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-fallback-collide",
          spec: spec({
            "/v1/a/b/c": { post: { operationId: "do.thing", ...OK } },
            "/v1/x/y/z": { post: { operationId: "do-thing", ...OK } },
          }),
          routes: RESOURCE_ACTION_V1,
        }),
      (err: Error) => {
        assert.match(err.message, /route slug "do-thing"/);
        assert.match(err.message, /resolved via fallback/);
        assert.match(err.message, /Rename one operation, schema, tag, or webhook/);
        assert.doesNotMatch(err.message, /routes\.operations` override/);
        return true;
      },
    );
  });

  test("a slug whose top segment is a reserved subtree fails the build", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-reserved",
          spec: spec({ "/v1/schemas": { get: { operationId: "listSchemas", ...OK } } }),
          routes: RESOURCE_ACTION_V1,
        }),
      /reserved route/i,
    );
  });
});

describe("no-regression & cache key", () => {
  test("without a routes policy, slugs are the legacy operationId form", async () => {
    const model = await buildApiModel({
      collection: "rp-legacy",
      spec: spec({ "/v1/charges": { get: { operationId: "listCharges", ...OK } } }),
      // no `routes` → legacy path: the slug is the operationId verbatim.
    });
    const slugs = new Map(getApiPageSlugs(model).map((s) => [s.coordinate, s.slug]));
    assert.equal(slugs.get("listCharges"), "listCharges");
  });

  test("the tagged legacy slug stays `<tagSegment>/<operationId>`, byte-for-byte", async () => {
    const model = await buildApiModel({
      collection: "rp-legacy-tag",
      spec: spec({ "/v1/charges": { get: { operationId: "listCharges", tags: ["Billing"], ...OK } } }),
      // no `routes` → legacy: a tag still routes as `<tagSegment>/<operationId>`.
    });
    const slug = new Map(getApiPageSlugs(model).map((s) => [s.coordinate, s.slug])).get("listCharges");
    assert.match(slug!, /^[^/]+\/listCharges$/, "tag segment prefixes the verbatim operationId");
  });

  test("the same bytes with different policies never alias in the model cache", async () => {
    const paths = { "/v1/things": { get: { operationId: "listThings", ...OK } } };
    const stripped = await buildApiModel({ collection: "rp-ck", spec: spec(paths), routes: RESOURCE_ACTION_V1 });
    const unstripped = await buildApiModel({
      collection: "rp-ck",
      spec: spec(paths),
      routes: { convention: "resource-action-v1" },
    });
    assert.notEqual(stripped, unstripped, "distinct policies → distinct cache entries");
    const a = new Map(getApiPageSlugs(stripped).map((s) => [s.coordinate, s.slug]));
    const b = new Map(getApiPageSlugs(unstripped).map((s) => [s.coordinate, s.slug]));
    assert.equal(a.get("listThings"), "things/list");
    assert.equal(b.get("listThings"), "list-things");
  });

  test("provenance is recorded for derived, override, and fallback pages", async () => {
    const model = await buildApiModel({
      collection: "rp-prov",
      spec: spec({
        "/v1/charges": { get: { operationId: "listCharges", ...OK } },
        "/v1/rpc/doThing": { post: { operationId: "doThing", ...OK } },
        "/v1/charges/{id}/x": member({ post: { operationId: "overrideMe", ...OK } }),
      }),
      routes: { convention: "resource-action-v1", stripPathPrefixes: ["/v1"], operations: { overrideMe: "charges/x" } },
    });
    const prov = getApiRouteProvenance(model);
    assert.equal(prov.get("listCharges"), "derived");
    assert.equal(prov.get("doThing"), "fallback");
    assert.equal(prov.get("overrideMe"), "override");
  });

  test("getApiRouteProvenance hands back a defensive copy, never the model's own map", async () => {
    const model = await buildApiModel({
      collection: "rp-prov-copy",
      spec: spec({ "/v1/charges": { get: { operationId: "listCharges", ...OK } } }),
      routes: RESOURCE_ACTION_V1,
    });
    const first = getApiRouteProvenance(model) as Map<string, string>;
    first.set("listCharges", "corrupted");
    first.delete("listCharges");
    // A second read is pristine — the caller mutated only its own copy.
    assert.equal(getApiRouteProvenance(model).get("listCharges"), "derived");
  });
});

// ── ID-less operations under a policy ───────────────────────────────────────

describe("resource-action-v1 derivation for an operation with no operationId", () => {
  test("derives the slug from method+path and warns (non-gating by default)", async () => {
    const { diagnostics, slugs, provenance } = await parseWith("rp-noid", {
      "/v1/charges": { get: { ...OK } },
    });
    // The coordinate is the path-derived fallback; the *slug* is still derived
    // by resource-action-v1 from method+path, decoupled from the (absent) operationId.
    const entry = [...slugs.entries()].find(([, s]) => s === "charges/list");
    assert.ok(entry, "the ID-less operation still derives charges/list");
    assert.equal(provenance.get(entry[0]), "derived");
    assert.ok(
      diagnostics.some((d) => d.level === "warning" && d.code === "missing-operation-id"),
      "an operation without an operationId warns",
    );
  });

  test("the same operation is fatal under requireOperationId", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-noid-strict",
          spec: spec({ "/v1/charges": { get: { ...OK } } }),
          routes: RESOURCE_ACTION_V1,
          requireOperationId: true,
        }),
      /add an operationId/i,
    );
  });

  test("a route-hostile path with no operationId is fatal regardless of routing", async () => {
    // The derived *slug* ("thing-raw/list") is perfectly safe — but the
    // path-derived *coordinate* carries a `%`, so identity (citation) safety,
    // which the slug never relieved, still fails the build.
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-noid-hostile",
          spec: spec({ "/v1/thing%raw": { get: { ...OK } } }),
          routes: RESOURCE_ACTION_V1,
        }),
      /percent sign|unsafe as a URL/i,
    );
  });
});

// ── the OTHER half of the identity/route split ──────────────────────────────

describe("resource-action-v1 keeps coordinate (citation) constraints on the operationId", () => {
  test("a reserved-namespace operationId still fails under resource-action-v1", async () => {
    // skipRouteFault drops only route-safety from the opaque id — the
    // reserved-namespace check that protects citations still runs.
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-reserved-id",
          spec: spec({ "/v1/errs": { get: { operationId: "errors", ...OK } } }),
          routes: RESOURCE_ACTION_V1,
        }),
      /reserved namespace/i,
    );
  });

  test("a colon-prefixed operationId still fails under resource-action-v1", async () => {
    await assert.rejects(
      () =>
        buildApiModel({
          collection: "rp-colon-id",
          spec: spec({ "/v1/things": { get: { operationId: "stripe:list", ...OK } } }),
          routes: RESOURCE_ACTION_V1,
        }),
      /"<name>:" prefix|cross-collection/i,
    );
  });

  test("case-only operationIds still warn under resource-action-v1", async () => {
    const { diagnostics } = await parseWith("rp-case-id", {
      "/v1/charges": { get: { operationId: "listCharge", ...OK } },
      "/v1/refunds": { get: { operationId: "listcharge", ...OK } },
    });
    assert.ok(
      diagnostics.some((d) => d.level === "warning" && /case/i.test(d.message)),
      "two operationIds differing only in case warn",
    );
  });
});

// ── empty derived resource, non-empty coordinate ────────────────────────────

describe("resource-action-v1 empty-derived-resource fallback (distinct from fatal empty)", () => {
  test("an empty derived resource with a nameable coordinate falls back and warns", async () => {
    // `/v1/___` derives an empty resource (null derivation), but the coordinate
    // "doThing" normalizes to a usable slug — so it's a warning-level fallback,
    // not the fatal empty case where even the coordinate normalizes away.
    const { diagnostics, slugs, provenance } = await parseWith("rp-empty-res", {
      "/v1/___": { get: { operationId: "doThing", ...OK } },
    });
    assert.equal(slugs.get("doThing"), "do-thing");
    assert.equal(provenance.get("doThing"), "fallback");
    assert.ok(
      diagnostics.some((d) => d.level === "warning" && d.code === "route-fallback"),
      "the empty-resource fallback surfaces a route-fallback warning",
    );
  });
});

// ── cross-version drift (loader) ────────────────────────────────────────────

async function runFamily(collection: string, versions: ApiVersionSpec[]): Promise<string[]> {
  const logs: string[] = [];
  const map = new Map<string, unknown>();
  const log = () => (msg: string) => void logs.push(msg);
  const store = {
    set: (e: { id: string }) => (e.id !== "" ? (map.set(e.id, e), true) : false),
    get: (id: string) => map.get(id),
    keys: () => [...map.keys()],
    values: () => [...map.values()],
    has: (id: string) => map.has(id),
    delete: (id: string) => void map.delete(id),
    clear: () => map.clear(),
    addModuleImport() {},
  };
  const context = {
    collection,
    store: store as never,
    meta: { get: () => undefined, set() {}, has: () => false, delete() {} },
    logger: { info: log(), warn: log(), error: log(), debug: log(), label: "t", fork: () => context.logger } as never,
    config: { root: pathToFileURL(new URL("..", import.meta.url).pathname) } as never,
    parseData: async <T,>({ data }: { data: T }) => data,
    renderMarkdown: async () => ({ html: "" }),
    generateDigest: (v: unknown) => JSON.stringify(v).length.toString(36),
    watcher: undefined,
  } as import("astro/loaders").LoaderContext;
  const { loader } = apiCollection({ collection, versions });
  await loader.load(context);
  return logs;
}

describe("cross-version drift", () => {
  const v1: ApiVersionSpec = {
    version: "v1",
    spec: spec({ "/payments": { get: { operationId: "chargeList", ...OK } } }),
    default: true,
    routes: { convention: "resource-action-v1" },
  };
  const v0: ApiVersionSpec = {
    version: "v0",
    spec: spec({ "/charges": { get: { operationId: "chargeList", ...OK } } }),
    routes: { convention: "resource-action-v1" },
  };

  test("one coordinate deriving different slugs across versions warns (non-gating)", async () => {
    const logs = await runFamily("rp-drift", [v1, v0]);
    assert.ok(
      logs.some((l) => /coordinate "chargeList" derives different resource-action-v1 slugs/.test(l)),
      "drift warning is emitted",
    );
  });

  test("an override in one version excludes it from drift", async () => {
    const pinned: ApiVersionSpec = {
      ...v0,
      routes: { convention: "resource-action-v1", operations: { chargeList: "payments/list" } },
    };
    const logs = await runFamily("rp-drift-pinned", [v1, pinned]);
    assert.ok(
      !logs.some((l) => /derives different resource-action-v1 slugs/.test(l)),
      "an overridden version is not compared, so no drift is reported",
    );
  });

  test("a version that falls back is excluded from drift (only derived slugs compared)", async () => {
    const derived: ApiVersionSpec = {
      version: "v1",
      spec: spec({ "/things": { get: { operationId: "doThing", ...OK } } }),
      default: true,
      routes: { convention: "resource-action-v1" },
    };
    // Same coordinate, but two static segments → fallback ("do-thing"), which
    // differs from v1's derived "things/list". Fallbacks are excluded, so despite
    // the differing slugs no drift is reported.
    const fell: ApiVersionSpec = {
      version: "v0",
      spec: spec({ "/rpc/doThing": { post: { operationId: "doThing", ...OK } } }),
      routes: { convention: "resource-action-v1" },
    };
    const logs = await runFamily("rp-drift-fallback", [derived, fell]);
    assert.ok(
      !logs.some((l) => /derives different resource-action-v1 slugs/.test(l)),
      "a fallback version is not compared, so differing slugs do not warn",
    );
  });

  test("a hidden version still participates in drift", async () => {
    const shown: ApiVersionSpec = {
      version: "v2",
      spec: spec({ "/payments": { get: { operationId: "chargeList", ...OK } } }),
      default: true,
      routes: { convention: "resource-action-v1" },
    };
    // Hidden versions still emit real URLs and links, so their derived-slug drift
    // must still be reported.
    const hidden: ApiVersionSpec = {
      version: "v1",
      spec: spec({ "/charges": { get: { operationId: "chargeList", ...OK } } }),
      hidden: true,
      routes: { convention: "resource-action-v1" },
    };
    const logs = await runFamily("rp-drift-hidden", [shown, hidden]);
    assert.ok(
      logs.some((l) => /coordinate "chargeList" derives different resource-action-v1 slugs/.test(l)),
      "a hidden version's derived slug drift is still reported",
    );
  });
});

// ── config validation ───────────────────────────────────────────────────────

function withApi(api: unknown): unknown {
  return { site: "https://example.com", title: "T", api };
}

describe("routes config validation — accepted", () => {
  test("a resource-action-v1 policy with prefixes and overrides", () => {
    assert.doesNotThrow(() =>
      validateNimbusConfig(
        withApi([
          {
            collection: "stripe",
            spec: "./stripe.json",
            routes: {
              convention: "resource-action-v1",
              stripPathPrefixes: ["/v1", "/2010-04-01"],
              operations: { PostChargesChargeDisputeClose: "charges/dispute/close" },
            },
          },
        ]),
      ),
    );
  });

  test("a per-version routes policy in a family", () => {
    assert.doesNotThrow(() =>
      validateNimbusConfig(
        withApi([
          {
            collection: "core",
            versions: [
              { version: "v2", spec: "./v2.yaml", default: true, routes: { convention: "resource-action-v1" } },
              { version: "v1", spec: "./v1.yaml", routes: { convention: "resource-action-v1" } },
            ],
          },
        ]),
      ),
    );
  });
});

describe("routes config validation — rejected", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    [
      "an unknown convention",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v2" } }],
      /resource-action-v1/,
    ],
    [
      "a prefix with a {parameter} segment",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v1", stripPathPrefixes: ["/v1/{id}"] } }],
      /\{parameter\}/i,
    ],
    [
      "a prefix with a .. traversal",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v1", stripPathPrefixes: ["../v1"] } }],
      /traversal/i,
    ],
    [
      "a prefix with an interior //",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v1", stripPathPrefixes: ["/v1//x"] } }],
      /interior|empty segment/i,
    ],
    [
      "a prefix with a percent-encoded segment",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v1", stripPathPrefixes: ["/v1/a%20b"] } }],
      /illegal character/i,
    ],
    [
      "a prefix with a sub-delimiter character",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v1", stripPathPrefixes: ["/v1/a,b"] } }],
      /illegal character/i,
    ],
    [
      "an override target that is not lowercase kebab-case",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v1", operations: { Foo: "Charges/Create" } } }],
      /kebab-case/i,
    ],
    [
      "an override target with a space",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v1", operations: { Foo: "a b" } } }],
      /kebab-case/i,
    ],
    [
      "a family-level routes policy (must be per-version)",
      [
        {
          collection: "core",
          routes: { convention: "resource-action-v1" },
          versions: [{ version: "v1", spec: "./v1.yaml" }],
        },
      ],
      /family level|per-version|move "routes"/i,
    ],
    [
      "an unknown key on the routes policy",
      [{ collection: "s", spec: "./s.json", routes: { convention: "resource-action-v1", stripPrefixes: ["/v1"] } }],
      /unknown api routes field "stripPrefixes"/i,
    ],
    [
      "an unknown key on an api entry",
      [{ collection: "s", spec: "./s.json", collectionName: "s" }],
      /unknown api entry field "collectionName"/i,
    ],
    [
      "an unknown key on a version entry",
      [{ collection: "s", versions: [{ version: "v1", spec: "./v1.json", defualt: true }] }],
      /unknown api version field "defualt"/i,
    ],
  ];
  for (const [name, api, pattern] of cases) {
    test(name, () => {
      assert.throws(() => validateNimbusConfig(withApi(api)), pattern);
    });
  }
});

describe("fallback routes in the build log", () => {
  test("many fallbacks print one summary and never hide other warnings", async (t) => {
    const lines: string[] = [];
    t.mock.method(console, "warn", (message: string) => void lines.push(message));
    const paths: Record<string, PathItem> = {
      "/v1/charges": { get: { operationId: "listCharge", ...OK } },
      "/v1/refunds": { get: { operationId: "listcharge", ...OK } },
    };
    for (let i = 0; i < 30; i++) paths[`/v1/${"_".repeat(i + 3)}`] = { get: { operationId: `doThing${i}`, ...OK } };
    const { diagnostics } = await parseWith("rp-fallback-log", paths);
    assert.equal(diagnostics.filter((d) => d.code === "route-fallback").length, 30);
    const fallbackLines = lines.filter((line) => /coordinate as the URL slug|falling back/.test(line));
    assert.equal(fallbackLines.length, 1);
    assert.match(fallbackLines[0]!, /30 operation\(s\).*doThing0, doThing1, doThing2, doThing3, doThing4, …/);
    assert.ok(lines.some((line) => /case/i.test(line)), "the case warning stays visible");
  });
});
