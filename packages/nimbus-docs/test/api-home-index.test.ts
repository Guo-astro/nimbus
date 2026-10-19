// The API home's index: every operation and webhook listed exactly once, in
// x-tagGroups order, with anchors that never collide; and its chunks, which
// never exceed their bound however the spec is shaped; and the later parts
// URLs, each a page of its own under the home.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import {
  buildApiModel,
  getApiNav,
  getApiPageProps,
  type ApiIndexSection,
  type ApiModel,
  type ApiNavItem,
  type ApiOperationRef,
  type ApiRootIndex,
  type ApiRootPage,
  type ApiSectionPage,
} from "../src/api/index.js";
import {
  apiHome,
  apiHomePartHref,
  apiIndexRows,
  chunkApiIndex,
  parseApiHomePart,
  type ApiIndexChunk,
} from "../src/_internal/api/home-index.js";
import { setLinkPolicy } from "../src/_internal/url.js";
import { coordinateAnchor } from "../src/_internal/api/view-model.js";

const ok = { "200": { description: "ok" } };
const op = (operationId: string, tags?: string[], extra: Record<string, unknown> = {}) => ({
  operationId,
  summary: operationId,
  ...(tags ? { tags } : {}),
  responses: ok,
  ...extra,
});

// Groups are declared in the reverse of the tag order, a group name is also a
// tag with its own operations, an operation is tagged with a group that has no
// page, a tag nests under another, one operation has no tag, and two tags show
// the same display name.
const spec = {
  openapi: "3.1.0",
  info: { title: "Shapes", version: "1" },
  "x-tagGroups": [
    { name: "Billing", tags: ["Invoices"] },
    { name: "Admin", tags: ["Users", "Équipes"] },
  ],
  tags: [
    { name: "Users", description: "People with access." },
    { name: "Équipes" },
    { name: "Members", parent: "Users" },
    { name: "Invoices" },
    { name: "Billing" },
    { name: "Spaced name" },
    { name: "Dupe one", "x-displayName": "Same" },
    { name: "Dupe two", "x-displayName": "Same" },
  ],
  paths: {
    "/users": { get: op("listUsers", ["Users"]), post: op("createUser", ["Users"], { description: "Adds a user." }) },
    "/users/{id}/members": { get: op("listMembers", ["Members"], { deprecated: true }) },
    "/teams": { get: op("listTeams", ["Équipes"]) },
    "/invoices": { get: op("listInvoices", ["Invoices"]) },
    "/billing": { get: op("billingSummary", ["Billing"]) },
    "/admin": { get: op("adminAudit", ["Admin"]) },
    "/spaced": { get: op("spaced", ["Spaced name"]) },
    "/one": { get: op("dupeOne", ["Dupe one"]) },
    "/two": { get: op("dupeTwo", ["Dupe two"]) },
    "/health": { get: op("health") },
  },
  webhooks: {
    "alert.created": { post: op("alertCreated") },
  },
} as Record<string, never>;

function indexRefs(index: ApiRootIndex): ApiOperationRef[] {
  const walk = (section: ApiIndexSection): ApiOperationRef[] => [
    ...section.operations,
    ...section.sections.flatMap(walk),
  ];
  return [
    ...index.groups.flatMap((g) => [...g.operations, ...g.sections.flatMap(walk)]),
    ...index.operations,
    ...index.webhooks,
  ];
}

function anchors(index: ApiRootIndex): string[] {
  const walk = (section: ApiIndexSection): string[] => [section.anchor, ...section.sections.flatMap(walk)];
  return index.groups.flatMap((g) => [g.anchor, ...g.sections.flatMap(walk)]);
}

function navOperations(items: ApiNavItem[]): string[] {
  return items.flatMap((item) => [
    ...(item.kind === "operation" && item.href ? [item.href] : []),
    ...navOperations(item.children),
  ]);
}

describe("the root page's index", () => {
  let model: ApiModel;
  let root: ApiRootPage;
  before(async () => {
    model = await buildApiModel({ collection: "shapes", spec, label: "shapes", schemaPages: true });
    root = getApiPageProps(model, "shapes") as ApiRootPage;
  });

  test("lists every operation and webhook exactly once", () => {
    const listed = indexRefs(root.index).map((ref) => ref.href);
    assert.equal(new Set(listed).size, listed.length, "no operation listed twice");
    // The sidebar lists the same pages: operations, then webhooks in their own group.
    assert.deepEqual(listed.sort(), navOperations(getApiNav(model).items).sort());
    assert.deepEqual(listed.filter((href) => href.includes("/webhooks/")), ["/shapes/webhooks/alert.created/"]);
    assert.equal(apiIndexRows(root.index).length, listed.length);
  });

  test("webhooks close the sidebar in their own group, open on a webhook's page", () => {
    const last = (nav: { items: ApiNavItem[] }) => nav.items.at(-1)!;
    const group = last(getApiNav(model));
    assert.equal(group.label, "Webhooks");
    assert.equal(group.href, undefined, "the group has no page of its own");
    assert.deepEqual(group.children.map((c) => c.href), ["/shapes/webhooks/alert.created/"]);
    const onHook = last(getApiNav(model, group.children[0]!.coordinate));
    assert.equal(onHook.expanded, true);
    assert.equal(onHook.children[0]!.active, true);
  });

  test("groups follow x-tagGroups, then the sections in no group", () => {
    assert.deepEqual(
      root.index.groups.map((g) => g.label),
      ["Billing", "Admin", null],
    );
    const [billing, admin, more] = root.index.groups;
    assert.ok(billing!.ref, "a group that is also a tag links to its page");
    assert.deepEqual(billing!.operations.map((o) => o.label), ["billingSummary"]);
    assert.equal(admin!.ref, undefined, "a group without a page has no link");
    assert.deepEqual(admin!.operations.map((o) => o.label), ["adminAudit"]);
    assert.deepEqual(admin!.sections.map((s) => s.ref.label), ["Users", "Équipes"]);
    assert.deepEqual(admin!.sections[0]!.sections.map((s) => s.ref.label), ["Members"]);
    assert.equal(more!.anchor, "more");
    assert.deepEqual(root.index.operations.map((o) => o.label), ["health"]);
    assert.deepEqual(root.index.webhooks.map((o) => [o.label, o.path, o.webhook]), [["alertCreated", "alert.created", true]]);
  });

  test("anchors come from coordinates, distinct for spaced, non-Latin and duplicate names", () => {
    const all = anchors(root.index);
    assert.equal(new Set(all).size, all.length);
    const users = root.index.groups[1]!.sections[0]!;
    assert.equal(users.anchor, coordinateAnchor("tags.Users"));
    for (const anchor of all) assert.match(anchor, /^[A-Za-z0-9._-]+$/);
  });

  test("index rows carry method and path, but no description", () => {
    const users = root.index.groups[1]!.sections[0]!;
    assert.deepEqual(users.operations.map((o) => [o.method, o.path]), [["GET", "/users"], ["POST", "/users"]]);
    assert.ok(users.operations.every((o) => o.description === undefined));
    assert.equal(users.description, "People with access.");
    assert.equal(users.sections[0]!.operations[0]!.deprecated, true);
  });

  test("section pages gain method, path and description; existing fields keep their values", () => {
    const users = getApiPageProps(model, "tags.Users") as ApiSectionPage;
    const navUsers = getApiNav(model).items.flatMap(function find(i): ApiNavItem[] {
      return i.coordinate === "tags.Users" ? [i] : i.children.flatMap(find);
    })[0]!;
    const navOps = navUsers.children.filter((c) => c.kind === "operation");
    assert.deepEqual(
      users.operations.map(({ label, href }) => ({ label, href })),
      navOps.map(({ label, href }) => ({ label, href })),
    );
    assert.deepEqual(users.operations[1], {
      label: "createUser",
      href: navOps[1]!.href,
      method: "POST",
      path: "/users",
      description: "Adds a user.",
    });
    assert.deepEqual(users.sections?.map((s) => s.label), ["Members"]);
    assert.deepEqual(
      root.sections.map((s) => s.label),
      ["Billing", "Spaced name", "Same", "Same", "Users", "Équipes"],
    );
  });

  test("a webhook-only spec lists its webhooks", async () => {
    const hooks = await buildApiModel({
      collection: "hooks",
      label: "hooks",
      spec: {
        openapi: "3.1.0",
        info: { title: "Hooks", version: "1" },
        webhooks: { "a.created": { post: op("aCreated") }, "b.deleted": { post: op("bDeleted") } },
      } as Record<string, never>,
    });
    const index = (getApiPageProps(hooks, "hooks") as ApiRootPage).index;
    assert.deepEqual(index.groups, []);
    assert.deepEqual(index.operations, []);
    assert.deepEqual(index.webhooks.map((w) => w.path), ["a.created", "b.deleted"]);
  });
});

// ── chunks ──────────────────────────────────────────────────────────────────

const ref = (n: number, prefix = "op"): ApiOperationRef => ({
  label: `${prefix} ${n}`,
  href: `/api/${prefix}-${n}/`,
  method: "GET",
  path: `/${prefix}/${n}`,
});
const refs = (count: number, prefix?: string) => Array.from({ length: count }, (_, i) => ref(i, prefix));
const section = (name: string, operations: ApiOperationRef[], sections: ApiIndexSection[] = []): ApiIndexSection => ({
  ref: { label: name, href: `/api/${name}/` },
  anchor: coordinateAnchor(`tags.${name}`),
  operations,
  sections,
});
const empty: ApiRootIndex = { groups: [], operations: [], webhooks: [] };

function chunkRefs(chunk: ApiIndexChunk): ApiOperationRef[] {
  return [
    ...chunk.groups.flatMap((g) => [...g.operations, ...g.sections.flatMap((s) => s.operations)]),
    ...(chunk.operations?.operations ?? []),
    ...(chunk.webhooks?.operations ?? []),
  ];
}

function assertBounded(index: ApiRootIndex, size = 150) {
  const chunks = chunkApiIndex(index, { size });
  const all = indexRefs(index).map((r) => r.href);
  const seen = chunks.flatMap(chunkRefs).map((r) => r.href);
  assert.deepEqual(seen, all, "every endpoint once, in order");
  let next = 1;
  for (const chunk of chunks) {
    const count = chunkRefs(chunk).length;
    assert.ok(count <= size, `chunk ${chunk.number} holds ${count}`);
    assert.equal(chunk.start, next);
    assert.equal(chunk.end, next + count - 1);
    next += count;
  }
  const ids = chunks.flatMap((c) => [
    ...c.groups.flatMap((g) => [...(g.continued ? [] : [g.anchor]), ...g.sections.map((s) => s.anchor)]),
    ...(c.operations ? [c.operations.anchor] : []),
    ...(c.webhooks ? [c.webhooks.anchor] : []),
  ]);
  assert.equal(new Set(ids).size, ids.length, "anchors are unique");
  return chunks;
}

describe("chunkApiIndex", () => {
  test("a 3,000-endpoint section splits into continued parts", () => {
    const chunks = assertBounded({
      groups: [{ label: null, anchor: "more", operations: [], sections: [section("Big", refs(3000))] }],
      operations: [],
      webhooks: [],
    });
    assert.equal(chunks.length, 20);
    assert.equal(chunks[1]!.groups[0]!.continued, true);
    assert.equal(chunks[1]!.groups[0]!.sections[0]!.anchor, `${coordinateAnchor("tags.Big")}--2`);
    assert.equal(chunks[1]!.groups[0]!.sections[0]!.continued, true);
  });

  test("3,000 untagged operations, or 3,000 webhooks", () => {
    const untagged = assertBounded({ ...empty, operations: refs(3000) });
    assert.equal(untagged[2]!.operations!.anchor, "endpoints--3");
    const hooks = assertBounded({ ...empty, webhooks: refs(3000, "hook") });
    assert.equal(hooks.length, 20);
  });

  test("a mixed spec keeps sections whole where they fit", () => {
    const groups = Array.from({ length: 30 }, (_, g) => ({
      label: `Group ${g}`,
      anchor: `g${g}`,
      operations: refs(g % 3, `g${g}`),
      sections: Array.from({ length: 4 }, (_, s) =>
        section(`s${g}-${s}`, refs((g * 7 + s * 13) % 60, `s${g}-${s}`), s === 0 ? [section(`n${g}`, refs(5, `n${g}`))] : []),
      ),
    }));
    const chunks = assertBounded({ groups, operations: refs(40, "u"), webhooks: refs(12, "w") });
    for (const chunk of chunks) {
      for (const g of chunk.groups) for (const s of g.sections) assert.equal(s.continued, false);
    }
    assert.ok(chunks.at(-1)!.webhooks, "webhooks come last");
  });

  test("no endpoints, no chunks", () => {
    assert.deepEqual(chunkApiIndex(empty), []);
    assert.deepEqual(
      chunkApiIndex({ groups: [{ label: null, anchor: "more", operations: [], sections: [section("Empty", [])] }], operations: [], webhooks: [] }),
      [],
    );
  });
});

describe("the home's later parts", () => {
  test("a part's id names its home and number; anything else is no part", () => {
    assert.deepEqual(parseApiHomePart("index/2"), { homeId: "index", part: 2 });
    assert.deepEqual(parseApiHomePart("v2/index/12"), { homeId: "v2", part: 12 });
    for (const id of ["index", "index/1", "index/0", "index/02", "index/two", "charges/index", "index/2/more"])
      assert.equal(parseApiHomePart(id), null, id);
  });

  test("a part's URL follows the site's trailing slash", (t) => {
    t.after(() => setLinkPolicy({ trailingSlash: "ignore", format: "directory" }));
    setLinkPolicy({ trailingSlash: "never", format: "directory" });
    assert.equal(apiHomePartHref("/api", 2), "/api/index/2");
    assert.equal(apiHomePartHref("/api?version=v2", 2), "/api/index/2?version=v2");
    setLinkPolicy({ trailingSlash: "always", format: "directory" });
    assert.equal(apiHomePartHref("/api/", 2), "/api/index/2/");
  });

  test("a part's URL sits under the home, keeping a version query", () => {
    assert.equal(apiHomePartHref("/api/", 1), "/api/");
    assert.equal(apiHomePartHref("/api/", 2), "/api/index/2/");
    assert.equal(apiHomePartHref("/api/v2/", 3), "/api/v2/index/3/");
    assert.equal(apiHomePartHref("/api/?version=v2", 2), "/api/index/2/?version=v2");
    assert.equal(apiHomePartHref("/", 2), "/index/2/");
  });

  test("the home view links every part and shows the one asked for", () => {
    const index: ApiRootIndex = { ...empty, operations: refs(320) };
    const home = apiHome(index, { homeHref: "/api/", part: 2, size: 150, listHref: "/_nimbus/pages/nav-x.json" })!;
    assert.equal(home.part.number, 2);
    assert.equal(home.total, 320);
    assert.equal(home.listHref, "/_nimbus/pages/nav-x.json");
    assert.deepEqual(
      home.parts.map(({ number, start, end, href }) => [number, start, end, href]),
      [
        [1, 1, 150, "/api/"],
        [2, 151, 300, "/api/index/2/"],
        [3, 301, 320, "/api/index/3/"],
      ],
    );
    assert.equal(apiHome(index, { homeHref: "/api/", part: 4, size: 150 }), null);
    assert.equal(apiHome(empty, { homeHref: "/api/", part: 1 }), null);
  });

  test("without a size, the whole list is one part", () => {
    const index = { ...empty, operations: refs(400) };
    assert.deepEqual(apiHome(index, { homeHref: "/api/", part: 1 })!.parts.map((part) => part.end), [400]);
    assert.equal(apiHome(index, { homeHref: "/api/", part: 2 }), null);
  });
});
