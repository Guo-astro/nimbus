---
"@cloudflare/nimbus-docs": patch
---

Publish the OpenAPI spec when a schema has a property named `$ref`. The publisher no longer reads the parser's complaint about such a property as an unresolved reference; real non-string references are still reported by location.
