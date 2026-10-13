---
"@cloudflare/nimbus-docs": patch
---

- Generated `_headers` rules leave out any header the site's own `_headers` already sets for that path, site-wide rules included, so hosts no longer send doubled values such as `Access-Control-Allow-Origin: *, *`.
