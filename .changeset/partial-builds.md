---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- `NIMBUS_BUILD_ONLY=docs-es` builds one collection, or a comma-separated set, and leaves the others empty; `dev`, `sync` and `check` ignore it with one notice.
- A slice without the `docs` collection writes its sitemap, search bundle, stylesheet, assets and `llms-full.txt` under its prefix, and drops the root files the root slice serves.
- The root slice's `llms.txt` lists every collection's `llms.txt`, and search merges the other slices' indexes at runtime.
- `nimbus-docs lint` checks links into other slices against the previous build's routes, as warnings.
- A slice build fails on an unknown collection, on docs version collections split across slices, and on a `base` other than `/`.
- The starter's search provider loads its slice's search bundle and merges the others.
- A guide, "Build one locale or one part", with the Worker and zone routes per slice and a workflow that builds the slice a pull request touched.
