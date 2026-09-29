// API version families. Pins the three strings a version resolves to
// (namespace / versionKey / mountPath), the nested-URL contract, the M1
// invariant that coordinates never carry the version (so pages link across
// versions), and the coordinate-identity alternates table (canonical = default,
// hidden excluded).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveApiFamily,
  resolveApiVersion,
  apiPageRoute,
} from "../src/_internal/api/resolve-versions.js";
import { buildApiVersionAlternates } from "../src/_internal/api/api-alternates.js";
import {
  buildApiModel,
  clearApiModelCache,
  getApiPageProps,
  getApiPageSlugs,
} from "../src/api/index.js";
import type { ApiSpec } from "../src/types.js";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/api/", import.meta.url));
function fixtureText(rel: string): string {
  return readFileSync(`${FIXTURE_ROOT}${rel}`, "utf8");
}

describe("apiPageRoute (loader store-id ↔ route param, single source)", () => {
  const def = { isDefault: true, version: "v2" };
  const nonDef = { isDefault: false, version: "v1" };

  test("default root → id `index`, param undefined (the bare mount)", () => {
    assert.deepEqual(apiPageRoute(def, ""), {
      storeId: "index",
      param: undefined,
    });
  });

  test("non-default root → id/param = the version id", () => {
    assert.deepEqual(apiPageRoute(nonDef, ""), { storeId: "v1", param: "v1" });
  });

  test("default non-root → the slug verbatim, id === param", () => {
    assert.deepEqual(apiPageRoute(def, "charges/create"), {
      storeId: "charges/create",
      param: "charges/create",
    });
  });

  test("non-default non-root → version-prefixed, id === param", () => {
    assert.deepEqual(apiPageRoute(nonDef, "charges/create"), {
      storeId: "v1/charges/create",
      param: "v1/charges/create",
    });
  });

  test("store id and route param never diverge (they must address one page)", () => {
    for (const target of [def, nonDef]) {
      for (const slug of ["", "a", "a/b", "schemas/X"]) {
        const { storeId, param } = apiPageRoute(target, slug);
        // The only sanctioned divergence is the default root, where the param
        // is `undefined` (Astro's index route) while the id is `index`.
        if (target.isDefault && slug === "") {
          assert.equal(param, undefined);
          assert.equal(storeId, "index");
        } else {
          assert.equal(storeId, param);
        }
      }
    }
  });
});

describe("resolveApiFamily", () => {
  test("unversioned collection resolves byte-identical to the pre-versioning shape", () => {
    const [target] = resolveApiFamily({ collection: "api", spec: "openapi.yaml" });
    assert.equal(target!.family, "api");
    assert.equal(target!.version, null);
    assert.equal(target!.isDefault, true);
    assert.equal(target!.namespace, "api");
    assert.equal(target!.versionKey, "api");
    assert.equal(target!.mountPath, "/api");
  });

  test("versioned family: default owns the bare mount, others nest", () => {
    const targets = resolveApiFamily({
      collection: "core",
      versions: [
        { version: "v4", spec: "v4.yaml", default: true },
        { version: "v3", spec: "v3.yaml", status: "deprecated" },
        { version: "v2", spec: "v2.yaml", hidden: true },
      ],
    });
    const byVersion = Object.fromEntries(targets.map((t) => [t.version, t]));

    assert.equal(byVersion.v4!.isDefault, true);
    assert.equal(byVersion.v4!.mountPath, "/core");
    assert.equal(byVersion.v4!.versionKey, "core@v4");

    assert.equal(byVersion.v3!.isDefault, false);
    assert.equal(byVersion.v3!.mountPath, "/core/v3");
    assert.equal(byVersion.v3!.versionKey, "core@v3");
    assert.equal(byVersion.v3!.status, "deprecated");

    assert.equal(byVersion.v2!.mountPath, "/core/v2");
    assert.equal(byVersion.v2!.hidden, true);
  });

  test("M1: every version shares the family namespace (coordinates never carry the version)", () => {
    const targets = resolveApiFamily({
      collection: "core",
      versions: [
        { version: "v2", spec: "v2.yaml", default: true },
        { version: "v1", spec: "v1.yaml" },
      ],
    });
    for (const t of targets) assert.equal(t.namespace, "core");
  });

  test("first entry is the default when none is flagged", () => {
    const targets = resolveApiFamily({
      collection: "core",
      versions: [
        { version: "v2", spec: "v2.yaml" },
        { version: "v1", spec: "v1.yaml" },
      ],
    });
    assert.equal(targets.find((t) => t.isDefault)!.version, "v2");
  });
});

describe("buildApiVersionAlternates — path-derived fallbacks (missing operationId)", () => {
  const fallbackFamily = (renameParam: boolean): Record<string, unknown> => ({
    openapi: "3.0.0",
    info: { title: "Fallbacks", version: "1.0.0" },
    paths: {
      "/widgets/{id}": {
        get: {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      [renameParam ? "/things/{key}" : "/things/{id}"]: {
        get: {
          parameters: [
            { name: renameParam ? "key" : "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

  const api: ApiSpec[] = [
    {
      collection: "fb",
      versions: [
        { version: "v2", spec: fallbackFamily(false), default: true },
        { version: "v1", spec: fallbackFamily(true), status: "deprecated" },
      ],
    },
  ];

  test("identical fallbacks link across versions (canonical → default)", async () => {
    clearApiModelCache("fb");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);
    const v1 = table["fb@v1:get/widgets/id"];
    assert.ok(v1, "the shared-path fallback has a cross-version record");
    assert.equal(v1!.canonical!.version, "v2", "v1 fallback canonicalizes to the default version");
    assert.ok(
      v1!.alternates.some((a) => a.version === "v2"),
      "and lists the v2 sibling as an alternate — the two are linked",
    );
  });

  test("a path-parameter rename moves the fallback, breaking the link", async () => {
    clearApiModelCache("fb");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);
    const v2 = table["fb@v2:get/things/id"];
    const v1 = table["fb@v1:get/things/key"];
    assert.ok(v2 && v1, "both renamed pages exist independently");
    assert.equal(v2!.canonical, null);
    assert.deepEqual(v2!.alternates, [], "v2 has no cross-version sibling");
    assert.deepEqual(v1!.alternates, [], "v1 has no cross-version sibling");
    assert.equal(
      table["fb@v1:get/things/id"],
      undefined,
      "v1 never minted the v2 coordinate — the rename severed the link",
    );
  });
});

describe("resolveApiVersion", () => {
  const api: ApiSpec[] = [
    {
      collection: "core",
      versions: [
        { version: "v2", spec: "v2.yaml", default: true },
        { version: "v1", spec: "v1.yaml" },
      ],
    },
  ];

  test("omitting the version selects the default", () => {
    assert.equal(resolveApiVersion(api, "core")!.version, "v2");
    assert.equal(resolveApiVersion(api, "core", null)!.version, "v2");
  });

  test("a named version selects that version", () => {
    assert.equal(resolveApiVersion(api, "core", "v1")!.mountPath, "/core/v1");
  });

  test("unknown collection or version resolves to undefined", () => {
    assert.equal(resolveApiVersion(api, "nope"), undefined);
    assert.equal(resolveApiVersion(api, "core", "v9"), undefined);
  });
});

describe("mountPath drives nested hrefs without moving coordinates", () => {
  const spec = fixtureText("smallco.yaml");

  test("default mount and a nested version mount produce disjoint, correctly-nested hrefs", async () => {
    clearApiModelCache("core");
    const def = await buildApiModel({ collection: "core", spec, mountPath: "/core" });
    const v1 = await buildApiModel({
      collection: "core",
      spec,
      mountPath: "/core/v1",
    });

    assert.equal(getApiPageProps(def, "create").href, "/core/charges/create/");
    assert.equal(getApiPageProps(v1, "create").href, "/core/v1/charges/create/");
    // Root nests too.
    assert.equal(getApiPageProps(def, "core").href, "/core/");
    assert.equal(getApiPageProps(v1, "core").href, "/core/v1/");
  });

  test("coordinates are byte-identical across mounts (M1 — enables cross-version linking)", async () => {
    clearApiModelCache("core");
    const def = await buildApiModel({ collection: "core", spec, mountPath: "/core" });
    const v1 = await buildApiModel({
      collection: "core",
      spec,
      mountPath: "/core/v1",
    });
    const coords = (m: Awaited<ReturnType<typeof buildApiModel>>) =>
      getApiPageSlugs(m)
        .map((p) => p.coordinate)
        .sort();
    assert.deepEqual(coords(def), coords(v1));
  });
});

describe("buildApiVersionAlternates — coordinate-identity axis", () => {
  // Both versions render the same fixture, so every coordinate exists in both
  // and forms a two-member class. v2 is the default (canonical target).
  const api: ApiSpec[] = [
    {
      collection: "core",
      versions: [
        { version: "v2", spec: "smallco.yaml", default: true },
        { version: "v1", spec: "smallco.yaml", status: "deprecated" },
      ],
    },
  ];

  test("keys carry the version key; canonical points at the default", async () => {
    clearApiModelCache("core");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);

    const v1Create = table["core@v1:create"];
    assert.ok(v1Create, "expected a record for the v1 create page");
    assert.equal(v1Create!.self.version, "v1");
    assert.equal(v1Create!.self.url, "/core/v1/charges/create/");
    // Canonical is the default (v2) sibling.
    assert.equal(v1Create!.canonical!.version, "v2");
    assert.equal(v1Create!.canonical!.url, "/core/charges/create/");

    // The default page is itself canonical → no canonical override.
    const v2Create = table["core@v2:create"];
    assert.ok(v2Create);
    assert.equal(v2Create!.canonical, null);
    assert.equal(
      v2Create!.alternates.some((a) => a.version === "v1"),
      true,
    );
  });

  test("M1: the root page links across versions (root coordinate is shared)", async () => {
    clearApiModelCache("core");
    const table = await buildApiVersionAlternates(api, FIXTURE_ROOT);
    const v1Root = table["core@v1:core"];
    assert.ok(v1Root, "root page must have a cross-version record");
    assert.equal(v1Root!.canonical!.url, "/core/");
  });

  test("hidden versions are excluded from other pages' alternates but keep their own record", async () => {
    const withHidden: ApiSpec[] = [
      {
        collection: "core",
        versions: [
          { version: "v2", spec: "smallco.yaml", default: true },
          { version: "v1", spec: "smallco.yaml" },
          { version: "v0", spec: "smallco.yaml", hidden: true },
        ],
      },
    ];
    clearApiModelCache("core");
    const table = await buildApiVersionAlternates(withHidden, FIXTURE_ROOT);

    // v2's alternates must not advertise the hidden v0.
    const v2Create = table["core@v2:create"];
    assert.equal(
      v2Create!.alternates.some((a) => a.version === "v0"),
      false,
    );
    // But v0 is still reachable — it has its own record + canonical to default.
    const v0Create = table["core@v0:create"];
    assert.ok(v0Create);
    assert.equal(v0Create!.canonical!.version, "v2");
  });

  test("an unversioned or single-version family produces no alternates", async () => {
    assert.deepEqual(
      await buildApiVersionAlternates(
        [{ collection: "api", spec: "smallco.yaml" }],
        FIXTURE_ROOT,
      ),
      {},
    );
    assert.deepEqual(
      await buildApiVersionAlternates(
        [{ collection: "core", versions: [{ version: "v1", spec: "smallco.yaml" }] }],
        FIXTURE_ROOT,
      ),
      {},
    );
  });
});
