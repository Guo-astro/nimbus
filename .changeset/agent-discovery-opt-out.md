---
"@cloudflare/nimbus-docs": minor
---

- `agents: { discovery: false }` leaves origin-root agent discovery to the site that owns the domain: no `/.well-known/ard.json`, `ai-catalog.json` or `api-catalog`, no `rel="ard"` or `rel="api-catalog"` homepage links, and your own `.well-known` files are kept.
