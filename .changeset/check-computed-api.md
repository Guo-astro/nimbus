---
"@cloudflare/nimbus-docs": patch
---

`nimbus-docs check` no longer asks for `rendering.collections` when the `api` config is computed: a zero-argument `apiCollection()` registration is taken as an API collection, with a note that the build confirms it.
