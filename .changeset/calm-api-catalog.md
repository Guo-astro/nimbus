---
"@cloudflare/nimbus-docs": minor
---

- Sites with API collections publish every spec, including hidden versions, as one self-contained `openapi.json` at its mount path, and list each visible API in an RFC 9727 catalog at `/.well-known/api-catalog`. Set `publishSpec: false` to keep a spec private.
