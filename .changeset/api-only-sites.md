---
"@cloudflare/nimbus-docs": minor
---

- An API reference can be the whole site: a route at `src/pages/[...slug].astro` serves the API collection at the root. Every URL Nimbus builds for it is root-relative: pages, the version picker, the sidebar, breadcrumbs, Markdown versions, `llms.txt`, the sitemap, `openapi.json` and the API catalog.
- A site whose `content.config.ts` declares no `docs` collection no longer queries one for the sidebar, so Astro's "collection does not exist" warning is gone. A sidebar that names `docs` still queries it.
