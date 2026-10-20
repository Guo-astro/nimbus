import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CollectionEntry } from "astro:content";

import type { ApiNav, ApiPageProps } from "../src/api/index.js";
import {
  resolveApiPage,
  resolveProsePage,
  type PageResolution,
  type PageResolutionContext,
  type ProsePage,
} from "../src/_internal/page-resolution.js";
import type { ApiSpec } from "../src/types.js";
import { collectionsByFolder } from "../src/_internal/collection-mount.js";
import {
  getApiPage,
  getCollectionPageProps,
  getDocsPageProps,
} from "../src/index.js";

/** A request context; the route pattern defaults to the URL's folder above the page. */
function context(
  pathname: string,
  slug: string | undefined,
  props: Record<string, unknown> = {},
  routePattern?: string,
): PageResolutionContext {
  const segments = pathname.split("/").filter(Boolean);
  const folder = segments.slice(0, segments.length - (slug?.split("/").length ?? 0));
  return {
    props,
    params: { slug },
    url: new URL(pathname, "https://example.com"),
    routePattern: routePattern ?? `/${[...folder, "[...slug]"].join("/")}`,
    projection: { audience: { key: "test" } },
  };
}

// `sdk` served from src/pages/products/kit/ with a kept copy at src/pages/es/sdk/,
// and the API from src/pages/reference/api/.
const folders = collectionsByFolder(["docs", "docs-v1", "blog", "sdk", "api"], {
  versions: { others: ["v1"] },
  routes: new Map([
    ["sdk", { mount: "/products/kit", file: "src/pages/products/kit/[...slug].astro", aliases: ["/es/sdk"] }],
    ["api", { mount: "/reference/api", file: "src/pages/reference/api/[...slug].astro", aliases: [] }],
  ]),
});
let warnings: string[] = [];
const routeDependencies = {
  async getCollectionAt(folder: string) {
    return folders.get(folder);
  },
  warn(message: string) {
    warnings.push(message);
  },
};

function entry(
  collection: string,
  id: string,
  data: Record<string, unknown> = {},
): CollectionEntry<string> {
  return { collection, id, data, body: `# ${id}` };
}

const Content = (() => undefined) as unknown as ProsePage["Content"];

test("the shared contract represents redirect outcomes", () => {
  const resolution: PageResolution = {
    status: "redirect",
    location: "/current/",
    permanent: true,
  };
  assert.equal(resolution.status, "redirect");
});

test("public static helpers preserve missing-prop diagnostics", async () => {
  await assert.rejects(
    () => getDocsPageProps({ props: {} } as never),
    /expected `entry` in Astro\.props/,
  );
  await assert.rejects(
    () => getCollectionPageProps({ props: {} } as never),
    /expected `entry` in Astro\.props/,
  );
  await assert.rejects(
    () => getApiPage({ props: {} } as never),
    /expected `collection` and `coordinate` in Astro\.props/,
  );
});

test("collection page helpers take the collection name, and still reject the removed options object", async () => {
  await assert.rejects(
    () => getCollectionPageProps({ props: {} } as never, "sdk"),
    /expected `entry` in Astro\.props/,
  );
  await assert.rejects(
    () => getCollectionPageProps({ props: {} } as never, {} as never),
    /getCollectionPageProps\(Astro, options\) was removed/,
  );
  await assert.rejects(
    () => getDocsPageProps({ props: {} } as never, {} as never),
    /getDocsPageProps\(Astro, options\) was removed/,
  );
  await assert.rejects(
    () => getDocsPageProps({ props: {} } as never, "blog" as never),
    /getDocsPageProps\(Astro\) always serves docs.*getCollectionPage\(Astro, "blog"\)/,
  );
  await assert.rejects(
    () => getCollectionPageProps({ props: {} } as never, undefined),
    /expected `entry` in Astro\.props/,
  );
});

describe("prose page resolution", () => {
  const entries = new Map([
    ["docs:index", entry("docs", "index")],
    ["docs:guides/setup", entry("docs", "guides/setup")],
    ["docs-v1:index", entry("docs-v1", "index")],
    ["docs-v1:v1", entry("docs-v1", "v1")],
    ["docs-v1:guides/setup", entry("docs-v1", "guides/setup")],
    ["blog:v1", entry("blog", "v1")],
    ["sdk:setup", entry("sdk", "setup")],
    ["sdk:index", entry("sdk", "index")],
  ]);
  let lookups: Array<{ collection: string; id: string; audience?: string }> =
    [];
  const dependencies = {
    ...routeDependencies,
    async getVisibleEntry(
      collection: string,
      id: string,
      projection?: PageResolutionContext["projection"],
    ) {
      lookups.push({ collection, id, audience: projection?.audience?.key });
      return entries.get(`${collection}:${id}`) ?? null;
    },
    async getVersions() {
      return { others: ["v1"] };
    },
    async render(value: CollectionEntry<string>) {
      return {
        Content,
        headings: [
          { depth: 1, text: value.id, slug: value.id.replaceAll("/", "-") },
        ],
      };
    },
  };

  test("uses an existing static entry without a collection lookup", async () => {
    lookups = [];
    const staticEntry = entry("docs", "static");
    const result = await resolveProsePage(
      context("/static/", "wrong", { entry: staticEntry }),
      { collection: "docs" },
      dependencies,
    );

    assert.equal(result.status, "found");
    if (result.status !== "found") return;
    assert.equal(result.page.entry, staticEntry);
    assert.equal(result.page.identity.pathname, "/static");
    assert.deepEqual(lookups, []);
  });

  test("resolves the root and nested docs paths through visible content", async () => {
    lookups = [];
    const root = await resolveProsePage(
      context("/", undefined),
      { collection: "docs" },
      dependencies,
    );
    const nested = await resolveProsePage(
      context("/guides/setup/", "guides/setup"),
      { collection: "docs" },
      dependencies,
    );

    assert.equal(root.status, "found");
    assert.equal(nested.status, "found");
    assert.deepEqual(lookups, [
      { collection: "docs", id: "index", audience: "test" },
      { collection: "docs", id: "guides/setup", audience: "test" },
    ]);
  });

  test("strips the leading prose version from root catch-all IDs", async () => {
    const versionRoot = await resolveProsePage(
      context("/v1/", "v1"),
      { collection: "docs" },
      dependencies,
    );
    const versionLeaf = await resolveProsePage(
      context("/v1/guides/setup/", "v1/guides/setup"),
      { collection: "docs" },
      dependencies,
    );
    const missing = await resolveProsePage(
      context("/missing/", "missing"),
      { collection: "docs" },
      dependencies,
    );

    assert.equal(versionRoot.status, "found");
    if (versionRoot.status === "found") {
      assert.equal(versionRoot.page.identity.collection, "docs-v1");
      assert.equal(versionRoot.page.entry.id, "index");
    }
    assert.equal(versionLeaf.status, "found");
    if (versionLeaf.status === "found") {
      assert.equal(versionLeaf.page.identity.collection, "docs-v1");
      assert.equal(versionLeaf.page.entry.id, "guides/setup");
    }
    assert.deepEqual(missing, { status: "not-found" });
  });

  test("does not strip version-like IDs inside mounted collection routes", async () => {
    const versionLeaf = await resolveProsePage(
      context("/v1/v1/", "v1"),
      {},
      dependencies,
    );
    const blogLeaf = await resolveProsePage(
      context("/blog/v1/", "v1"),
      {},
      dependencies,
    );

    assert.equal(versionLeaf.status, "found");
    if (versionLeaf.status === "found") {
      assert.equal(versionLeaf.page.identity.collection, "docs-v1");
      assert.equal(versionLeaf.page.entry.id, "v1");
    }
    assert.equal(blogLeaf.status, "found");
    if (blogLeaf.status === "found") {
      assert.equal(blogLeaf.page.identity.collection, "blog");
      assert.equal(blogLeaf.page.entry.id, "v1");
    }
  });
  test("an index path is not a second URL for a landing", async () => {
    for (const [pathname, slug, collection] of [
      ["/index", "index", "docs"],
      ["/index/", "index", "docs"],
      ["/v1/index", "v1/index", "docs"],
      ["/products/kit/index/", "index", undefined],
    ] as const) {
      const result = await resolveProsePage(context(pathname, slug), { collection }, dependencies);
      assert.deepEqual(result, { status: "not-found" }, pathname);
    }
    const landing = await resolveProsePage(context("/products/kit/", undefined, {}, "/products/kit/[...slug]"), {}, dependencies);
    assert.equal(landing.status, "found");
  });

  test("a request route's page helper names its collection", async () => {
    const result = await resolveProsePage(context("/products/kit/setup/", "setup", {}, "/products/kit/[...slug]"), { collection: "sdk" }, dependencies);
    assert.equal(result.status, "found");
    if (result.status === "found") assert.equal(result.page.identity.collection, "sdk");
  });

  test("resolves a request route by its folder, nested, under a base, or a kept copy", async () => {
    for (const [pathname, pattern] of [
      ["/products/kit/setup/", "/products/kit/[...slug]"],
      ["/docs/products/kit/setup/", "/products/kit/[...slug]"],
      ["/es/sdk/setup/", "/es/sdk/[...slug]"],
    ] as const) {
      const result = await resolveProsePage(context(pathname, "setup", {}, pattern), {}, dependencies);
      assert.equal(result.status, "found", pathname);
      if (result.status === "found") assert.equal(result.page.identity.collection, "sdk");
    }
  });

  test("a request route under a folder no collection is served from is not found, reported once", async () => {
    warnings = [];
    for (let i = 0; i < 2; i++) {
      const result = await resolveProsePage(context("/kits/sdk/setup/", "setup"), {}, dependencies);
      assert.deepEqual(result, { status: "not-found" });
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /the route \/kits\/sdk\/\[\.\.\.slug\] renders on request, but no page collection is served from \/kits\/sdk/);
    assert.match(warnings[0]!, /#collection-urls/);
  });

  test("a request route under a dynamic folder resolves by the URL segment before the page", async () => {
    const result = await resolveProsePage(context("/es/blog/v1/", "v1", {}, "/[locale]/blog/[...slug]"), {}, dependencies);
    assert.equal(result.status, "found");
    if (result.status === "found") assert.equal(result.page.identity.collection, "blog");
  });
});

describe("API page resolution", () => {
  const api: ApiSpec[] = [
    {
      collection: "api",
      versions: [
        { version: "v2", spec: {}, default: true },
        { version: "v1", spec: {} },
      ],
    },
  ];
  const entries = new Map([
    // A root page's coordinate is its collection's name.
    ["api:index", entry("api", "index", { coordinate: "api", version: "v2" })],
    [
      "api:charges/create",
      entry("api", "charges/create", {
        coordinate: "createCharge",
        version: "v2",
      }),
    ],
    ["api:v1", entry("api", "v1", { coordinate: "api", version: "v1" })],
    // `index` is reserved only at the top, so an operation can end in it.
    ["api:search/index/2", entry("api", "search/index/2", { coordinate: "searchIndexTwo", version: "v2" })],
    [
      "api:v1/charges/create",
      entry("api", "v1/charges/create", {
        coordinate: "createCharge",
        version: "v1",
      }),
    ],
  ]);
  let lookups: Array<{ collection: string; id: string; audience?: string }> =
    [];
  let collectionLoads = 0;
  const dependencies = {
    ...routeDependencies,
    async getApiCollections() {
      collectionLoads++;
      return api.map(({ collection }) => collection);
    },
    async getVisibleEntry(
      collection: string,
      id: string,
      projection?: PageResolutionContext["projection"],
    ) {
      lookups.push({ collection, id, audience: projection?.audience?.key });
      return entries.get(`${collection}:${id}`) ?? null;
    },
    async render(
      collection: string,
      version: string | null,
      coordinate: string,
    ) {
      const page: ApiPageProps = {
        apiSchemaVersion: 1,
        kind: "api",
        collection,
        coordinate,
        href: "/api",
        markdownHref: "/api/index.md",
        title: coordinate,
        breadcrumbs: [],
        servers: [],
        sections: [],
        ...(version ? { version } : {}),
      };
      const nav: ApiNav = { apiSchemaVersion: 1, collection, items: [] };
      return { page, nav };
    },
  };

  test("resolves a static API identity by its lightweight route props", async () => {
    lookups = [];
    collectionLoads = 0;
    const result = await resolveApiPage(
      context("/api/charges/create/", "charges/create", {
        collection: "api",
        version: "v2",
        coordinate: "createCharge",
      }),
      {},
      dependencies,
    );

    assert.equal(result.status, "found");
    if (result.status !== "found") return;
    assert.equal(result.page.coordinate, "createCharge");
    assert.equal(result.page.version, "v2");
    assert.deepEqual(lookups, [
      { collection: "api", id: "charges/create", audience: "test" },
    ]);
    assert.equal(collectionLoads, 0);
  });

  test("resolves default root and nested API request paths", async () => {
    lookups = [];
    const root = await resolveApiPage(
      context("/base/reference/api/", undefined, {}, "/reference/api/[...slug]"),
      {},
      dependencies,
    );
    const nested = await resolveApiPage(
      context("/reference/api/charges/create/", "charges/create"),
      {},
      dependencies,
    );

    assert.equal(root.status, "found");
    assert.equal(nested.status, "found");
    assert.deepEqual(lookups, [
      { collection: "api", id: "index", audience: "test" },
      { collection: "api", id: "charges/create", audience: "test" },
    ]);
  });

  test("resolves version roots and leaves from their indexed store IDs", async () => {
    const root = await resolveApiPage(
      context("/reference/api/v1/", "v1"),
      {},
      dependencies,
    );
    const leaf = await resolveApiPage(
      context("/reference/api/v1/charges/create/", "v1/charges/create"),
      {},
      dependencies,
    );

    assert.equal(root.status, "found");
    assert.equal(leaf.status, "found");
    if (root.status === "found") assert.equal(root.page.version, "v1");
    if (leaf.status === "found")
      assert.equal(leaf.page.coordinate, "createCharge");
  });

  test("returns not-found for missing and unknown API paths", async () => {
    const missing = await resolveApiPage(
      context("/reference/api/missing/", "missing"),
      {},
      dependencies,
    );
    const unknown = await resolveApiPage(
      context("/unknown/", undefined),
      {},
      dependencies,
    );
    const rootAlias = await resolveApiPage(
      context("/reference/api/index/", "index"),
      {},
      dependencies,
    );

    assert.deepEqual(missing, { status: "not-found" });
    assert.deepEqual(unknown, { status: "not-found" });
    assert.deepEqual(rootAlias, { status: "not-found" });
  });

  test("resolves the home's later parts to the home, on request or built", async () => {
    const request = await resolveApiPage(context("/reference/api/index/2/", "index/2"), {}, dependencies);
    const versioned = await resolveApiPage(context("/reference/api/v1/index/3/", "v1/index/3"), {}, dependencies);
    const built = await resolveApiPage(
      context("/api/index/2/", "index/2", { collection: "api", version: "v2", coordinate: "api", homePart: 2 }),
      {},
      dependencies,
    );
    for (const [result, part, version] of [
      [request, 2, "v2"],
      [versioned, 3, "v1"],
      [built, 2, "v2"],
    ] as const) {
      assert.equal(result.status, "found");
      if (result.status !== "found") continue;
      assert.equal(result.page.coordinate, "api");
      assert.equal(result.page.version, version);
      assert.equal(result.page.homePart, part);
    }
  });

  test("a page whose own URL ends in index/<n> is that page, not a part", async () => {
    const request = await resolveApiPage(context("/reference/api/search/index/2/", "search/index/2"), {}, dependencies);
    const built = await resolveApiPage(
      context("/api/search/index/2/", "search/index/2", { collection: "api", version: "v2", coordinate: "searchIndexTwo" }),
      {},
      dependencies,
    );
    for (const result of [request, built]) {
      assert.equal(result.status, "found");
      if (result.status !== "found") continue;
      assert.equal(result.page.coordinate, "searchIndexTwo");
      assert.equal(result.page.homePart, undefined);
    }
  });

  test("only the home has later parts, numbered from 2", async () => {
    for (const slug of ["charges/create/index/2", "index/1", "index/02", "missing/index/2"]) {
      const result = await resolveApiPage(context(`/reference/api/${slug}/`, slug), {}, dependencies);
      assert.deepEqual(result, { status: "not-found" }, slug);
    }
  });

  test("preserves an unversioned API's null version", async () => {
    const result = await resolveApiPage(
      context("/legacy/", undefined),
      { collection: "legacy" },
      {
        ...dependencies,
        async getApiCollections() {
          return ["legacy"];
        },
        async getVisibleEntry() {
          return entry("legacy", "index", { coordinate: "root" });
        },
      },
    );

    assert.equal(result.status, "found");
    if (result.status === "found") assert.equal(result.page.version, null);
  });
});
