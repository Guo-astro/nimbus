---
"@cloudflare/nimbus-docs": patch
---

Static API pages color their code samples again. `_nimbus/shiki.css` now defines every token class the pages use; it used to miss the classes only API samples used, so on a site with only API pages, every sample rendered without color.
