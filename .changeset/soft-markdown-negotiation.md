---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- On server output, a request-rendered page returns its Markdown when the request prefers `text/markdown`; the URL stays canonical and both forms send `Vary: Accept`.
- The starter homepage renders on request when a collection already does under server output, so it negotiates too.
