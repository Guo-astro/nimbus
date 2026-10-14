---
"@cloudflare/nimbus-docs": patch
"@cloudflare/create-nimbus-docs": patch
---

- New Cloudflare projects, and `nimbus-docs add adapter-cloudflare` when `wrangler.jsonc` has no valid date, get a `compatibility_date` the installed Workers runtime supports instead of today's date, so local dev starts.
