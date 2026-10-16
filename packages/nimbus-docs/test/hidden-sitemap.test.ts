// Hidden-version sitemap exclusion. Pins the prefix computation (docs + API
// axes, base-aware) and the filter predicate's boundary behaviour: a hidden
// prefix drops itself and everything nested, never a sibling that merely shares
// leading characters, and never the (never-hidden) default API mount.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  hiddenVersionPrefixes,
  makeHiddenSitemapFilter,
} from "../src/_internal/hidden-sitemap.js";
import type { NimbusConfig } from "../src/types.js";
import { NO_ROUTES } from "../src/_internal/collection-mount.js";

const DEFAULT_URLS = { versions: null, routes: NO_ROUTES };

function config(partial: Partial<NimbusConfig>): NimbusConfig {
  return { title: "t", ...partial } as NimbusConfig;
}

describe("hiddenVersionPrefixes", () => {
  test("empty when nothing is hidden", () => {
    assert.deepEqual(hiddenVersionPrefixes(config({}), "/", DEFAULT_URLS), []);
    assert.deepEqual(
      hiddenVersionPrefixes(
        config({
          versions: { current: "v2", others: ["v1"] },
          api: [{ collection: "core", versions: [{ version: "v1", spec: "a.yaml" }] }],
        }),
        "/",
        DEFAULT_URLS,
      ),
      [],
    );
  });

  test("collects docs hidden slugs and API hidden mount paths", () => {
    const prefixes = hiddenVersionPrefixes(
      config({
        versions: { current: "v3", others: ["v1", "v2"], hidden: ["v1"] },
        api: [
          {
            collection: "core",
            versions: [
              { version: "v4", spec: "v4.yaml", default: true },
              { version: "v3", spec: "v3.yaml" },
              { version: "v2", spec: "v2.yaml", hidden: true },
            ],
          },
        ],
      }),
      "/",
      DEFAULT_URLS,
    );
    assert.deepEqual(prefixes.sort(), ["/core/v2", "/v1"]);
  });

  test("never includes the default API mount (defaults cannot be hidden)", () => {
    const prefixes = hiddenVersionPrefixes(
      config({
        api: [
          {
            collection: "core",
            versions: [
              { version: "v2", spec: "v2.yaml", default: true },
              { version: "v1", spec: "v1.yaml", hidden: true },
            ],
          },
        ],
      }),
      "/",
      DEFAULT_URLS,
    );
    assert.ok(!prefixes.includes("/core"));
    assert.deepEqual(prefixes, ["/core/v1"]);
  });

  test("is base-aware for sub-path deployments", () => {
    assert.deepEqual(
      hiddenVersionPrefixes(
        config({ versions: { current: "v2", others: ["v1"], hidden: ["v1"] } }),
        "/docs/",
        DEFAULT_URLS,
      ),
      ["/docs/v1"],
    );
  });
});

describe("makeHiddenSitemapFilter", () => {
  const cfg = config({
    versions: { current: "v2", others: ["v1"], hidden: ["v1"] },
    api: [
      {
        collection: "core",
        versions: [
          { version: "v2", spec: "v2.yaml", default: true },
          { version: "v1", spec: "v1.yaml", hidden: true },
        ],
      },
    ],
  });
  const keep = makeHiddenSitemapFilter(cfg, "/", DEFAULT_URLS);

  test("drops the hidden prefix page and everything nested", () => {
    assert.equal(keep("https://x.dev/v1"), false);
    assert.equal(keep("https://x.dev/v1/"), false);
    assert.equal(keep("https://x.dev/v1/guide/intro/"), false);
    assert.equal(keep("https://x.dev/core/v1"), false);
    assert.equal(keep("https://x.dev/core/v1/charges/create/"), false);
  });

  test("keeps visible pages, including the default API mount and prefix look-alikes", () => {
    assert.equal(keep("https://x.dev/"), true);
    assert.equal(keep("https://x.dev/v2/guide/"), true);
    assert.equal(keep("https://x.dev/core/"), true);
    assert.equal(keep("https://x.dev/core/charges/create/"), true);
    // A sibling that merely shares the leading characters must survive.
    assert.equal(keep("https://x.dev/v10/"), true);
    assert.equal(keep("https://x.dev/core/v10/"), true);
  });

  test("passthrough filter keeps everything when nothing is hidden", () => {
    const all = makeHiddenSitemapFilter(config({}), "/", DEFAULT_URLS);
    assert.equal(all("https://x.dev/v1/"), true);
    assert.equal(all("https://x.dev/core/v1/"), true);
  });
});
