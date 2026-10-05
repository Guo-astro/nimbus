import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registerDocumentationWebMcp,
  initDocumentationWebMcp,
  type DocumentationModelContext,
} from "../src/client/webmcp.js";
import { documentationSearchTool } from "../src/_internal/agent-search-contract.js";

type Tool = Parameters<DocumentationModelContext["registerTool"]>[0];
const options = {
  site: "https://example.test",
  title: "Example",
  base: "/docs",
  versions: ["v2", "v1"],
  search: "pagefind" as const,
};
const execution = () => ({ signal: new AbortController().signal });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function context() {
  let calls = 0;
  let tool: Tool | undefined;
  let registered: () => void;
  const ready = new Promise<void>((resolve) => {
    registered = resolve;
  });
  return {
    get calls() {
      return calls;
    },
    get tool() {
      return tool;
    },
    ready,
    async registerTool(next: Tool, options: { signal: AbortSignal }) {
      calls++;
      assert.equal(tool, undefined, "duplicate registration");
      tool = next;
      options.signal.addEventListener(
        "abort",
        () => {
          tool = undefined;
        },
        { once: true },
      );
      registered();
    },
  };
}
function pagefind() {
  let imports = 0,
    instances = 0,
    destroyed = 0,
    initialized = 0;
  const filters: unknown[] = [];
  const index = {
    async init() {
      initialized++;
    },
    async filters() {},
    async destroy() {
      destroyed++;
    },
    async search(query: string, options: unknown) {
      filters.push(options);
      return {
        results: [
          {
            data: async () => ({
              url: "/guide/",
              meta: { title: "Guide" },
              excerpt: "Text",
              sub_results: [
                {
                  title: "Start",
                  url: "/guide/#start",
                  excerpt: `<mark>${query}</mark> &amp; details`,
                },
              ],
            }),
          },
        ],
      };
    },
  };
  return {
    get imports() {
      return imports;
    },
    get instances() {
      return instances;
    },
    get destroyed() {
      return destroyed;
    },
    get initialized() {
      return initialized;
    },
    filters,
    index,
    async load() {
      imports++;
      return {
        createInstance(config: unknown) {
          instances++;
          assert.deepEqual(config, {
            basePath: "/docs/pagefind/",
            baseUrl: "/docs/",
          });
          return index;
        },
      };
    },
  };
}

test("WebMCP registers the shared schema, loads only on first call, and shares one isolated initialization", async () => {
  const model = context();
  const engine = pagefind();
  const dispose = registerDocumentationWebMcp(model, options, engine.load);
  await model.ready;
  assert.equal(engine.imports, 0);
  assert.deepEqual(
    model.tool?.inputSchema,
    documentationSearchTool("Example", options.versions).inputSchema,
  );
  assert.equal(model.tool?.name, "search_documentation");
  assert.match(model.tool?.description ?? "", /Example/);
  assert.equal(model.tool?.annotations.readOnlyHint, true);
  const results = await Promise.all([
    model.tool!.execute({ query: "alpha" }, execution()),
    model.tool!.execute({ query: "beta", version: "v1" }, execution()),
  ]);
  assert.equal(engine.imports, 1);
  assert.equal(engine.instances, 1);
  assert.equal(engine.initialized, 1);
  assert.deepEqual(results[0], {
    results: [
      {
        title: "Guide",
        heading: "Start",
        url: "https://example.test/docs/guide/#start",
        excerpt: "alpha & details",
      },
    ],
  });
  assert.deepEqual(engine.filters, [
    { filters: { status: { none: ["deprecated"] } } },
    { filters: { version: "v1" } },
  ]);
  dispose();
  await tick();
  assert.equal(model.tool, undefined);
  assert.equal(engine.destroyed, 1);
});

test("invalid input, missing indexes, and query failures keep the shared error contract", async () => {
  const model = context();
  let fail = true;
  const engine = pagefind();
  const dispose = registerDocumentationWebMcp(model, options, async () => {
    if (fail) throw Error("private loader path");
    return engine.load();
  });
  await model.ready;
  assert.deepEqual(await model.tool!.execute({ query: "" }, execution()), {
    error: {
      code: "invalid_input",
      message:
        "Provide a non-empty query of at most 500 characters, a limit from 1 to 20, and a visible version if supported.",
    },
  });
  assert.deepEqual(await model.tool!.execute({ query: "test" }, execution()), {
    error: {
      code: "index_unavailable",
      message: "Search index unavailable; run a build first.",
    },
  });
  fail = false;
  engine.index.search = async () => {
    throw Error("private query details");
  };
  assert.deepEqual(await model.tool!.execute({ query: "test" }, execution()), {
    error: {
      code: "search_failed",
      message: "Documentation search failed. Try again.",
    },
  });
  dispose();
});

test("an index-readiness failure is unavailable, cleans up, and can retry", async () => {
  const model = context();
  const engine = pagefind();
  let fail = true;
  engine.index.filters = async () => {
    if (fail) throw Error("index missing");
  };
  const dispose = registerDocumentationWebMcp(model, options, engine.load);
  await model.ready;
  assert.equal(
    (
      (await model.tool!.execute({ query: "test" }, execution())) as {
        error: { code: string };
      }
    ).error.code,
    "index_unavailable",
  );
  assert.equal(engine.destroyed, 1);
  fail = false;
  assert.ok(
    "results" in
      ((await model.tool!.execute({ query: "test" }, execution())) as object),
  );
  assert.equal(engine.imports, 2);
  dispose();
});

test("duplicate mounts and navigation races neither duplicate nor retain registrations", async () => {
  const model = context();
  const engine = pagefind();
  const first = registerDocumentationWebMcp(model, options, engine.load);
  const duplicate = registerDocumentationWebMcp(model, options, engine.load);
  await model.ready;
  duplicate();
  assert.ok(model.tool);
  assert.equal(model.calls, 1);
  first();
  assert.equal(model.tool, undefined);
  const stale = registerDocumentationWebMcp(model, options, engine.load);
  stale();
  const next = registerDocumentationWebMcp(model, options, engine.load);
  await tick();
  assert.equal(model.calls, 2);
  assert.ok(model.tool);
  next();
});

test("unsupported environments and disabled search do no work", async () => {
  assert.doesNotThrow(() => initDocumentationWebMcp(options)());
  const model = context();
  const engine = pagefind();
  registerDocumentationWebMcp(
    model,
    { ...options, search: "unavailable" },
    engine.load,
  )();
  await tick();
  assert.equal(model.calls, 0);
  assert.equal(engine.imports, 0);
});

test("registration rejection is contained and does not delete another registration", async () => {
  let calls = 0;
  const model: DocumentationModelContext = {
    async registerTool() {
      calls++;
      throw Error("permissions policy denied");
    },
  };
  registerDocumentationWebMcp(model, options, pagefind().load);
  await tick();
  await tick();
  const dispose = registerDocumentationWebMcp(model, options, pagefind().load);
  await tick();
  assert.equal(calls, 2);
  dispose();
});

test("aborted calls and disposed tools cannot load or return search data", async () => {
  const model = context();
  const engine = pagefind();
  const dispose = registerDocumentationWebMcp(model, options, engine.load);
  await model.ready;
  const tool = model.tool!;
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    tool.execute({ query: "test" }, { signal: abort.signal }),
    { name: "AbortError" },
  );
  dispose();
  await assert.rejects(tool.execute({ query: "test" }, execution()), {
    name: "AbortError",
  });
  assert.equal(engine.imports, 0);
});

test("old Pagefind gives an actionable typed error and warns once across calls and remounts", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const model = context();
  const old = async () =>
    ({}) as Awaited<ReturnType<ReturnType<typeof pagefind>["load"]>>;
  const dispose = registerDocumentationWebMcp(model, options, old);
  await model.ready;
  const check = async () => {
    const result = (await model.tool!.execute(
      { query: "test" },
      execution(),
    )) as { error: { code: string; message: string } };
    assert.equal(result.error.code, "index_unavailable");
    assert.match(result.error.message, /Pagefind 1\.5\.2 or newer/);
    assert.match(result.error.message, /upgrade Pagefind and rebuild/);
  };
  await check();
  await check();
  dispose();
  const next = registerDocumentationWebMcp(model, options, old);
  await tick();
  await check();
  assert.equal(warning.mock.callCount(), 1);
  next();
});
