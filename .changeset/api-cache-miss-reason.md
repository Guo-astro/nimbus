---
"@cloudflare/nimbus-docs": patch
---

When an API version is prepared instead of reused, the "Prepared API pages" line now says which input changed (the spec, routes, samples, extensions, or Nimbus and its installed packages), or that it is the first build for that version. Preparation, bake and staging timings print under `astro build --verbose`.
