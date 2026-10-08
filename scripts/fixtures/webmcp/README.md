# WebMCP browser verification

The implementation follows the [2026-10-02 WebMCP community draft](https://webmachinelearning.github.io/webmcp/),
checked against [revision 6891d0e8](https://github.com/webmachinelearning/webmcp/tree/6891d0e857a0b35d8478aa8a01958565fb5466cd).
It uses `Document.modelContext`, asynchronous `registerTool`, and the registration's
`AbortSignal` for cleanup. It does not implement older navigator-based APIs or ship
a polyfill. The native execution result serializes the shared contract's object.

The browser helper loads a separate Pagefind 1.5.2+ instance on first execution.
It waits for index readiness, shares initialization among concurrent calls, and
uses the shared search adapter's serialization of search plus result hydration.
It never destroys the default instance used by the site's search dialog.

Run these **sequentially**, from the repository root (template checks and some
packed-consumer tests rebuild the framework's dist directory):

```sh
pnpm --filter @cloudflare/nimbus-docs build
pnpm --filter @cloudflare/nimbus-docs exec node --import tsx --test test/webmcp.test.ts test/agent-search.test.ts
pnpm webmcp:check
```

The harness builds the real starter with `base: /docs`, serves it only on localhost,
and uses Playwright Chromium. It verifies no Pagefind requests in an unsupported
browser, registration without eager search-parser or index loading, concurrent calls
before the search dialog opens, anchored URLs and readable excerpts, isolation from
normal search, real Astro view-transition cleanup, typed missing-index and search-chunk errors,
cancellation during a failed chunk load, recovery after reload, and
real version filters (including explicit deprecated-version searches). The small
visibility fixture runs as part of this harness without an external corpus.

Fragment and metadata 404s must recover on the next call in the same document
after the missing assets are restored. Failed JavaScript imports may require a
reload; the errors explain that distinction. Ordinary search remains isolated.

## Open Pagefind index-chunk failure

Pagefind 1.5.2 swallows `.pf_index` loading failures and caches the failed load.
This is an open acceptance failure, not a passing no-results case. To reproduce
without Nimbus, serve a real Pagefind build and use browser request interception
to return 404 for `**/*.pf_index`:

```js
const pagefind = await import("/pagefind/pagefind.js");
const index = pagefind.createInstance({ basePath: "/pagefind/", baseUrl: "/" });
await index.init();
await index.filters();
await index.search("a term known to be indexed");
// Restore chunk requests, then repeat the search on the same instance.
// Pagefind returns empty results; reload and a new instance restore matches.
await index.destroy();
```

Expected: the failed search rejects and permits recovery after restoration.
Observed: the failure is logged internally but the search resolves empty, and
the same instance remains empty. Instance replacement cannot establish that an
empty result was a failure. Do not intercept global fetch or classify all empty
results as errors to work around this; pursue the correction through Pagefind's
public API/upstream implementation.

The installed Chromium does **not** expose the current `Document.modelContext`
API. The supported-browser cases use a test-only facade of the pinned draft's
registration and abort behavior. These are integration checks with real Pagefind
and real browser navigation, not a claim of native browser interoperability or a
WPT conformance run. The harness prints native API availability explicitly.

Nothing is deployed by these checks. An external isitagentready score is not
recorded for local-only branches; no readiness level is claimed.
