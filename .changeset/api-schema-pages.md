---
"@cloudflare/nimbus-docs": minor
---

Add `schemaPages` to `api` entries, so an API reference can show types only inline. `true` (the default) keeps today's output. With `false`, schemas still shape operation pages, including the properties previewed under each union variant, but get no page, Markdown version, OG image, sitemap, search, or `llms.txt` entry, or citation coordinate. Union variants, discriminator mappings, and `map<Name>` types that linked to a schema page render as text. A citation in your content to a schema or schema field fails the build and names the setting. Schema names still claim their `schemas/<Name>` routes, so turning pages back on can't collide with an operation.
