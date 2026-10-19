---
"@cloudflare/nimbus-docs": patch
---

- A page's title or description can no longer end the head's structured data (`application/ld+json`) and run script; `NimbusHead` escapes `<` in it.
