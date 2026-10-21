---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": minor
---

- Route files say how they render. `nimbus-docs check` reports each route Nimbus manages whose file disagrees with `rendering`, and `check --fix` rewrites it: the `prerender` line, getStaticPaths on built routes only, and the collection name in a collection route's page helper. Without `rendering`, Nimbus builds every one of these routes ahead of time, a collection route such as `src/pages/sdk/[...slug].astro` included. `rendering` still wins at build, which now warns once and lists the files.
- A built dynamic route with no getStaticPaths fails the build, naming the file; Astro can't build it.
- The page helpers take the collection as a second argument, such as `getCollectionPage(Astro, "sdk")` or `getApiRoute(Astro, "api", { homeChunkSize })`, so a request-rendered route needs no getStaticPaths to say which collection it serves. A route whose getStaticPaths and helper name different collections fails with `nimbus/collection-route-mismatch`.
- `add adapter-*` updates route files after setting `rendering`, and its recipes run `check --fix`.
- `outdated` and `diff` compare starter route files in the site's own mode, so a route `check --fix` edited doesn't read as a local change.
- The starter's Markdown, `llms.txt` and docs page routes drop `export const prerender = true`; the site's `output` and `rendering` decide how they render. A scaffold with a server adapter writes its route files in the mode its `rendering` gives them.
