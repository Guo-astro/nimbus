import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectionMountPrefix, collectionUrlsKey, NO_ROUTES } from "../src/_internal/collection-mount.js";
import {
  collectionOwnershipErrors,
  decideCollectionMounts,
  findCollectionRoutes,
  readRoute,
  routePattern,
  routeSegments,
  sidebarPrefixWarnings,
  unreadRouteWarnings,
  type FoundRoute,
} from "../src/_internal/collection-routes.js";

const route = (frontmatter: string) => `---\n${frontmatter}\n---\n<html></html>\n`;

test("a route's collection comes from its exported getStaticPaths, in every supported shape", () => {
  const cases: Array<[string, string | undefined]> = [
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport const getStaticPaths = getCollectionStaticPaths("sdk");', "sdk"],
    ['import { getApiStaticPaths as api } from "@cloudflare/nimbus-docs";\nexport const getStaticPaths = api("rest");', "rest"],
    ['import * as nimbus from "@cloudflare/nimbus-docs/runtime";\nexport const getStaticPaths = nimbus.getCollectionStaticPaths(`blog`);', "blog"],
    ['import { getDocsStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport const getStaticPaths = getDocsStaticPaths;', "docs"],
    ['import { getDocsStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport async function getStaticPaths() { return getDocsStaticPaths(); }', "docs"],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport const getStaticPaths = async (options) => {\n  const paths = await getCollectionStaticPaths("sdk")(options);\n  return paths;\n};', "sdk"],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport const paths = getCollectionStaticPaths("sdk");\nexport const getStaticPaths = paths;', "sdk"],
    // Astro's compiler rejects these, so they aren't read.
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nconst getStaticPaths = getCollectionStaticPaths("sdk");\nexport { getStaticPaths };', undefined],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nconst paths = getCollectionStaticPaths("sdk");\nexport { paths as getStaticPaths };', undefined],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nimport type { GetStaticPaths } from "astro";\nexport const getStaticPaths = (async (o) => getCollectionStaticPaths("sdk")(o)) satisfies GetStaticPaths;', "sdk"],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport const load = (o) => getCollectionStaticPaths("changelog")(o);\nexport const getStaticPaths = (o) => load(o);', "changelog"],
    // Astro can't run a top-level name that isn't exported, so it isn't read.
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nconst load = (o) => getCollectionStaticPaths("changelog")(o);\nexport const getStaticPaths = (o) => load(o);', undefined],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nfunction load(o) { return getCollectionStaticPaths("changelog")(o); }\nexport const getStaticPaths = load;', undefined],
    // The changelog recipe's shape.
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nimport type { GetStaticPaths } from "astro";\nexport const getStaticPaths: GetStaticPaths = async (options) =>\n  (await getCollectionStaticPaths("changelog")(options)).filter(\n    (path) => path.params.slug,\n  );', "changelog"],
    // An unused call elsewhere in the file doesn't decide anything.
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nconst unused = getCollectionStaticPaths("cli");\nexport const getStaticPaths = getCollectionStaticPaths("sdk");', "sdk"],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport const name = "sdk";\nexport const getStaticPaths = getCollectionStaticPaths(name);', "sdk"],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nconst name = "sdk";\nexport const getStaticPaths = getCollectionStaticPaths(name);', undefined],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nlet name = "sdk";\nname = "cli";\nexport const getStaticPaths = getCollectionStaticPaths(name);', undefined],
    // A parameter elsewhere named like the import doesn't hide it.
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nfunction x(getCollectionStaticPaths) {}\nexport const getStaticPaths = getCollectionStaticPaths("sdk");', "sdk"],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nconst load = (o) => load(o);\nexport const getStaticPaths = load;', undefined],
    ['export { getStaticPaths } from "./shared";', undefined],
    // A local that shadows the import isn't the helper.
    ['import { getCollectionStaticPaths as paths } from "@cloudflare/nimbus-docs/runtime";\nexport function getStaticPaths() {\n  const paths = (label) => [{ params: { slug: label } }];\n  return paths("sdk");\n}', undefined],
    ['import * as nimbus from "@cloudflare/nimbus-docs/runtime";\nexport const getStaticPaths = (nimbus) => nimbus.getCollectionStaticPaths("sdk");', undefined],
    ['import * as nimbus from "@cloudflare/nimbus-docs/runtime";\nexport function getStaticPaths() {\n  class nimbus { static getCollectionStaticPaths() { return []; } }\n  return nimbus.getCollectionStaticPaths("sdk");\n}', undefined],
    ['import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nconst load = () => getCollectionStaticPaths("sdk");\nexport function getStaticPaths() {\n  const load = () => [];\n  return load();\n}', undefined],
    ['import { getCollectionStaticPaths } from "./my-helpers";\nexport const getStaticPaths = getCollectionStaticPaths("sdk");', undefined],
  ];
  for (const [frontmatter, expected] of cases) {
    assert.equal(readRoute(route(frontmatter)).collection, expected, frontmatter);
  }
});

test("route segments and patterns follow Astro's file routing", () => {
  assert.deepEqual(routeSegments("products/sdk/[...slug].astro"), ["products", "sdk", "[...slug]"]);
  assert.deepEqual(routeSegments("products/sdk/[...slug]/index.astro"), ["products", "sdk", "[...slug]"]);
  assert.deepEqual(routeSegments("products\\sdk\\[slug].astro"), ["products", "sdk", "[slug]"]);
  assert.equal(routePattern("/products/sdk", "src/pages/products/sdk/[slug].astro"), "/products/sdk/[slug]");
});

test("findCollectionRoutes reads every slug route under src/pages, skipping _ files and other params", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-collection-routes-"));
  const write = (file: string, frontmatter: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), route(frontmatter));
  };
  const call = (name: string) =>
    `import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport const getStaticPaths = getCollectionStaticPaths("${name}");`;
  try {
    write("src/pages/products/kit/[...slug].astro", call("sdk"));
    write("src/pages/blog/[slug]/index.astro", call("blog"));
    write("src/pages/blog/tags/[tag].astro", call("blog"));
    write("src/pages/_drafts/[...slug].astro", call("drafts"));
    write("src/pages/[locale]/sdk/[...slug].astro", call("sdk"));
    write("src/pages/v[version]/cli/[...slug].astro", call("cli"));
    write("src/pages/tools/[...slug].astro", 'import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nimport { wrap } from "../wrap";\nexport const getStaticPaths = wrap(getCollectionStaticPaths("tools"));');
    write("src/pages/[locale]/tools/[...slug].astro", 'import { getCollectionStaticPaths } from "@cloudflare/nimbus-docs/runtime";\nexport { getStaticPaths } from "../shared";');
    write("src/pages/pages/[slug].astro", 'export function getStaticPaths() { return []; }');
    const { found, unread } = findCollectionRoutes(path.join(root, "src"), root);
    assert.deepEqual(unread, [{ folder: "/tools", file: "src/pages/tools/[...slug].astro" }]);
    assert.deepEqual(
      found.map(({ collection, folder, file, dynamic }) => [collection, folder, file, dynamic]),
      [
        ["sdk", "/[locale]/sdk", "src/pages/[locale]/sdk/[...slug].astro", true],
        ["blog", "/blog", "src/pages/blog/[slug]/index.astro", false],
        ["sdk", "/products/kit", "src/pages/products/kit/[...slug].astro", false],
        ["cli", "/v[version]/cli", "src/pages/v[version]/cli/[...slug].astro", true],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const found = (collection: string, folder: string, dynamic = false): FoundRoute => ({
  collection,
  folder,
  file: `src/pages${folder}/[...slug].astro`,
  dynamic,
});

test("decideCollectionMounts: route folders, defaults, aliases and the errors for broken URLs", () => {
  const versions = { others: ["v1"] };
  const { mounts, errors, warnings } = decideCollectionMounts(
    [
      found("docs", ""),
      found("docs", "/es"),
      found("sdk", "/products/kit"),
      found("api", "/api"),
      found("api", "/es/api"),
      found("guides", "/[locale]/guides", true),
      found("guides", "/guides"),
      found("docs-v1", "/v1"),
    ],
    versions,
    ["api"],
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(mounts.get("docs"), { mount: "", file: "src/pages/[...slug].astro", aliases: ["/es"] });
  assert.equal(mounts.get("sdk")?.mount, "/products/kit");
  assert.deepEqual(mounts.get("api"), { mount: "/api", file: "src/pages/api/[...slug].astro", aliases: ["/es/api"] });
  assert.equal(mounts.get("guides")?.mount, "/guides");
  assert.equal(mounts.get("docs-v1")?.mount, "/v1");
  assert.deepEqual(warnings.map((warning) => warning.code), ["nimbus/collection-alias-route", "nimbus/collection-alias-route"]);
  assert.match(warnings[0]!.message, /^src\/pages\/es\/\[\.\.\.slug\]\.astro also serves collection "docs", which is served at \/ /);
  assert.match(warnings[1]!.message, /redirect \/es\/api to \/api\.$/);

  const codes = (routes: FoundRoute[]) => decideCollectionMounts(routes, versions, ["api"]).errors.map((error) => error.code);
  assert.deepEqual(codes([found("sdk", "/a"), found("sdk", "/b")]), ["nimbus/collection-two-routes"]);
  assert.deepEqual(codes([found("docs", "/guide")]), ["nimbus/collection-docs-route"]);
  assert.deepEqual(codes([found("docs-v1", "/old/v1")]), ["nimbus/collection-version-route"]);
  assert.deepEqual(codes([found("sdk", "/[locale]/sdk", true)]), ["nimbus/collection-dynamic-folder"]);
  assert.deepEqual(codes([found("docs", "/[locale]", true)]), []);
  assert.deepEqual(codes([found("sdk", "/tools"), found("cli", "/tools")]), ["nimbus/collection-same-url"]);
  assert.deepEqual(codes([found("guides", ""), found("docs", "")]), ["nimbus/collection-same-url"]);
  assert.deepEqual(codes([found("api", "")]), ["nimbus/collection-api-root"]);
  assert.deepEqual(codes([found("guides", "")]), []);
});

test("unread helper routes warn only where no collection is served by default", () => {
  const warnings = unreadRouteWarnings([
    { folder: "", file: "src/pages/[...slug].astro" },
    { folder: "/sdk", file: "src/pages/sdk/[...slug].astro" },
    { folder: "/products/kit", file: "src/pages/products/kit/[...slug].astro" },
  ]);
  assert.deepEqual(warnings.map((warning) => warning.code), ["nimbus/collection-unread-route"]);
  assert.match(warnings[0]!.message, /couldn't read the getStaticPaths in src\/pages\/products\/kit\/\[\.\.\.slug\]\.astro/);
});

test("ownership: the deepest mount owns a URL, on whole segments, and only moved collections error", () => {
  const context = {
    versions: null,
    routes: new Map([
      ["docs", { mount: "", file: "src/pages/[...slug].astro", aliases: [] }],
      ["sdk", { mount: "/products/sdk", file: "src/pages/products/sdk/[...slug].astro", aliases: [] }],
      ["cli", { mount: "/products/sdk/cli", file: "src/pages/products/sdk/cli/[...slug].astro", aliases: [] }],
      ["api", { mount: "/api", file: "src/pages/api/[...slug].astro", aliases: [] }],
    ]),
  };
  const entry = (collection: string, url: string) => ({ collection, url, source: `${collection}:${url}` });
  const errors = collectionOwnershipErrors(
    [
      entry("sdk", "/products/sdk/setup/"),
      entry("cli", "/products/sdk/cli/install/"),
      entry("sdk", "/products/sdk/cli/install/"),
      entry("docs", "/products/sdk/overview/"),
      entry("docs", "/products/sdkx/"),
      entry("docs", "/api/authentication/"),
    ],
    ["docs", "sdk", "cli", "api", "blog"],
    context,
  );
  assert.deepEqual(
    errors.map((error) => [error.code, error.message.split(" is at ")[0]]),
    [
      ["nimbus/collection-owns-url", "sdk page sdk:/products/sdk/cli/install/"],
      ["nimbus/collection-owns-url", "docs page docs:/products/sdk/overview/"],
    ],
  );
  const defaulted = collectionOwnershipErrors(
    [],
    ["blog", "news"],
    { versions: null, routes: new Map([["news", { mount: "/blog", file: "src/pages/blog/[...slug].astro", aliases: [] }]]) },
  );
  assert.deepEqual(defaulted.map((error) => error.code), ["nimbus/collection-same-url"]);
});

test("sidebar prefix: deprecated for a routed collection, kept for a hand-routed one", () => {
  const context = {
    versions: null,
    routes: new Map([["sdk", { mount: "/products/sdk", file: "src/pages/products/sdk/[...slug].astro", aliases: [] }]]),
  };
  const warnings = sidebarPrefixWarnings(
    [
      { autogenerate: { collection: "sdk", prefix: "/products/sdk/" } },
      { label: "Group", items: [{ autogenerate: { collection: "sdk", prefix: "/proxy/sdk" } }] },
      { autogenerate: { collection: "blog", prefix: "/news" } },
      { autogenerate: { collection: "sdk" } },
    ],
    context,
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /repeats the URL its route sets.*remove it/);
  assert.match(warnings[1]!, /overrides the URL its route sets \(\/products\/sdk/);
});

test("collectionMountPrefix reads the route map, then the defaults", () => {
  const routes = new Map([["sdk", { mount: "/products/sdk", file: "x", aliases: [] }]]);
  assert.equal(collectionMountPrefix("sdk", { versions: null, routes }), "/products/sdk");
  assert.equal(collectionMountPrefix("blog", { versions: null, routes }), "/blog");
  assert.equal(collectionMountPrefix("docs", { versions: null, routes: NO_ROUTES }), "");
  assert.equal(collectionMountPrefix("docs-v1", { versions: { others: ["v1"] }, routes: NO_ROUTES }), "/v1");
});

test("the cache key names only collections a route moved, so sites that move nothing keep their caches", () => {
  const record = (mount: string) => ({ mount, file: `src/pages${mount}/[...slug].astro`, aliases: [] });
  const versions = { others: ["v1"] };
  const unmoved = new Map([["docs", record("")], ["docs-v1", record("/v1")], ["api", record("/api")]]);
  assert.equal(collectionUrlsKey({ versions, routes: unmoved }), undefined);
  assert.equal(collectionUrlsKey({ versions, routes: NO_ROUTES }), undefined);
  const moved = new Map([...unmoved, ["sdk", record("/products/kit")]]);
  assert.equal(collectionUrlsKey({ versions, routes: moved }), JSON.stringify([["sdk", "/products/kit"]]));
});
