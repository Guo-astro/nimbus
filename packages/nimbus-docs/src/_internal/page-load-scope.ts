import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks the async context of a page or partials collection's load (and its
 * watcher handlers in dev). `glob()` and in-memory loaders render `.md`
 * during the load, before the collection is recorded, so passes that must
 * treat that Markdown as a Nimbus page ask the scope, not the file's folder.
 */
export interface PageLoadScope {
  collection: string;
}

const PAGE_LOAD_SCOPE_KEY = Symbol.for(
  "@cloudflare/nimbus-docs/page-load-scope/v1",
);
const scopeGlobal = globalThis as typeof globalThis & {
  [PAGE_LOAD_SCOPE_KEY]?: AsyncLocalStorage<PageLoadScope>;
};
const pageLoadScope = (scopeGlobal[PAGE_LOAD_SCOPE_KEY] ??=
  new AsyncLocalStorage<PageLoadScope>());

export function runInPageLoadScope<T>(
  collection: string,
  operation: () => T,
): T {
  return pageLoadScope.run({ collection }, operation);
}

export function currentPageLoadScope(): PageLoadScope | undefined {
  return pageLoadScope.getStore();
}
