---
"@cloudflare/nimbus-docs": minor
---

- A collection is served where its route file is: `src/pages/products/sdk/[...slug].astro` serves `sdk` at `/products/sdk`, and every URL Nimbus builds follows: pages, sidebar, Markdown versions, `llms.txt`, sitemap, search, social cards, and for an API its versions, `openapi.json` and catalog entry. Sites whose route folders match their collection names build the same output.
- `getCollectionUrl(collection)` returns where a collection is served, for links in components.
- `nimbus-docs check` lists where each collection is served when a route moves one; `check --json` always includes it.
- Sites that build broken URLs today now fail with an error naming the file and the fix: several routes for one collection with none at its default URL, two collections on one URL, a collection served only from dynamic folders, a docs or version route away from its URL, a page under another collection's moved URL, an API collection at the site root, or a route helper running in a route its collection isn't served from.
- A sidebar `prefix` for a collection served by a route helper is deprecated: the route sets the URL.
