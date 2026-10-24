---
"@cloudflare/nimbus-docs": patch
---

Parse an API spec's text once for the walk and the ref-preserving copy instead of three times. Validation keeps its own parse because the parser's validator rewrites a non-string `info.version` on the object it is handed.
