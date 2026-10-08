---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- Only collections made with Nimbus's helpers (`docsCollection()`, `componentsCollection()`, `withNimbusMarkdown()`) become pages; every other collection is plain Astro data with no naming rule, and the `_` prefix convention is removed. If `rendering` is set, a site's own page collection with a catch-all route now needs an entry in `rendering.collections`.
