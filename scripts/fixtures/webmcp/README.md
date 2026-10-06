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

The installed Chromium does **not** expose the current `Document.modelContext`
API. The supported-browser cases use a test-only facade of the pinned draft's
registration and abort behavior. These are integration checks with real Pagefind
and real browser navigation, not a claim of native browser interoperability or a
WPT conformance run. The harness prints native API availability explicitly.

Nothing is deployed by these checks. An external isitagentready score is not
recorded for local-only branches; no readiness level is claimed.
