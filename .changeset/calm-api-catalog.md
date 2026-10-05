---
"@cloudflare/nimbus-docs": minor
---

- Sites with API collections publish each visible spec as one self-contained `openapi.json` at its mount path and list every API in an RFC 9727 catalog at `/.well-known/api-catalog`. Set `publishSpec: false` to keep a spec private.
