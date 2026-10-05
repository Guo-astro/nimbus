import {
  documentationSearchTool,
  PagefindCompatibilityError,
  searchFailure,
} from "../_internal/agent-search-contract.js";
import type {
  DocumentationPagefind,
  DocumentationSearchOptions,
} from "../_internal/agent-search-contract.js";

export interface DocumentationWebMcpOptions extends DocumentationSearchOptions {
  title: string;
  search: "pagefind" | "unavailable";
}

interface PagefindInstance extends DocumentationPagefind {
  init(): Promise<unknown>;
  filters(): Promise<unknown>;
  destroy(): Promise<unknown>;
}
interface PagefindModule {
  createInstance(options: {
    basePath: string;
    baseUrl: string;
  }): PagefindInstance;
}
export interface DocumentationModelContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: true; untrustedContentHint: true };
      execute(
        input: unknown,
        options: { signal: AbortSignal },
      ): Promise<unknown>;
    },
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}

const compatibilityWarnings = new WeakSet<DocumentationModelContext>();
const registrations = new WeakMap<DocumentationModelContext, AbortController>();

/** @internal Loader seam used by the browser conformance tests. */
export function registerDocumentationWebMcp(
  context: DocumentationModelContext,
  options: DocumentationWebMcpOptions,
  importPagefind: () => Promise<PagefindModule>,
): () => void {
  if (options.search !== "pagefind" || registrations.has(context))
    return () => {};
  const lifetime = new AbortController();
  registrations.set(context, lifetime);
  let loading: Promise<PagefindInstance> | undefined;
  let instance: PagefindInstance | undefined;
  const base = `/${(options.base ?? "/").split("/").filter(Boolean).join("/")}`;
  const baseUrl = base === "/" ? "/" : `${base}/`;

  const destroy = () => {
    lifetime.abort();
    if (registrations.get(context) === lifetime) registrations.delete(context);
    const current = instance;
    instance = undefined;
    if (current) void current.destroy().catch(() => {});
  };

  const load = () =>
    (loading ??= (async () => {
      let candidate: PagefindInstance | undefined;
      try {
        lifetime.signal.throwIfAborted();
        const module = await importPagefind();
        lifetime.signal.throwIfAborted();
        if (typeof module.createInstance !== "function") {
          const error = new PagefindCompatibilityError();
          if (!compatibilityWarnings.has(context)) {
            compatibilityWarnings.add(context);
            console.warn(`nimbus-docs: ${error.message}`);
          }
          throw error;
        }
        candidate = module.createInstance({
          basePath: `${baseUrl}pagefind/`,
          baseUrl,
        });
        instance = candidate;
        await candidate.init();
        // init() may only initialize the worker wrapper. filters() also waits for
        // the index/WASM, so an absent previous build is index_unavailable.
        await candidate.filters();
        lifetime.signal.throwIfAborted();
        return candidate;
      } catch (error) {
        if (candidate && instance === candidate) {
          instance = undefined;
          void candidate.destroy().catch(() => {});
        }
        loading = undefined;
        throw error;
      }
    })());

  // Registration needs only the small contract. The parser/search implementation
  // is fetched once the tool is actually called, never just to expose its schema.
  let search:
    | Promise<
        ReturnType<
          (typeof import("../_internal/agent-search.js"))["createDocumentationSearch"]
        >
      >
    | undefined;
  void Promise.resolve()
    .then(() => {
      if (lifetime.signal.aborted) return;
      return context.registerTool(
        {
          ...documentationSearchTool(options.title, options.versions),
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          async execute(input, execution) {
            lifetime.signal.throwIfAborted();
            execution.signal.throwIfAborted();
            search ??= import("../_internal/agent-search.js")
              .then(({ createDocumentationSearch }) =>
                createDocumentationSearch(load, options),
              )
              .catch((error) => {
                search = undefined;
                throw error;
              });
            const run = await search.catch(() => undefined);
            lifetime.signal.throwIfAborted();
            execution.signal.throwIfAborted();
            if (!run) return searchFailure("search_failed");
            const result = await run(input);
            lifetime.signal.throwIfAborted();
            execution.signal.throwIfAborted();
            return result;
          },
        },
        { signal: lifetime.signal },
      );
    })
    .catch(destroy);
  return destroy;
}

/** Current WebMCP draft (2026-10-02): Document.modelContext + registration signal. */
export function initDocumentationWebMcp(
  options: DocumentationWebMcpOptions,
): () => void {
  if (options.search !== "pagefind" || typeof document === "undefined")
    return () => {};
  let context: DocumentationModelContext | undefined;
  try {
    context = (
      document as Document & { modelContext?: DocumentationModelContext }
    ).modelContext;
  } catch {
    return () => {};
  }
  if (!context || typeof context.registerTool !== "function") return () => {};
  const base = `/${(options.base ?? "/").split("/").filter(Boolean).join("/")}`;
  const moduleUrl = new URL(
    `${base === "/" ? "" : base}/pagefind/pagefind.js`,
    location.origin,
  ).href;
  return registerDocumentationWebMcp(
    context,
    options,
    () => import(/* @vite-ignore */ moduleUrl),
  );
}
