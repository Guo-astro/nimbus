---
"@cloudflare/nimbus-docs": patch
---

Stage agent-endpoint files by clone, checking each directory once instead of walking every path per file, and build the request-route inventory from the Markdown twins the bake just wrote instead of rendering every API page a second time.
