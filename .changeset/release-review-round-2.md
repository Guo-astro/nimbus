---
"@cloudflare/nimbus-docs": patch
"@cloudflare/create-nimbus-docs": patch
---

- `lint` and `check` accept relative links between a content source's pages, which the build turns into page URLs.
- Search in a slice of several collections skips the other collections' bundles instead of failing. `@cloudflare/nimbus-docs/client` exports `mergeSearchIndexes`, which the starter's search provider uses.
- API operation pages keep field names, types and labels apart in search, and leave the expand controls out.
- The search button's accessible name starts with its visible label, and API pages name their sidebars.
