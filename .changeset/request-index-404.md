---
"@cloudflare/nimbus-docs": patch
---

- On request rendering, `/index`, `/<collection>/index` and `/<version>/index` return 404 instead of a copy of the landing page, as built pages do.
