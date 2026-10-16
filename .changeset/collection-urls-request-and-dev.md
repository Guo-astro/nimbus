---
"@cloudflare/nimbus-docs": minor
---

- Request-rendered collections are served where their route file is too, nested folders, kept copies and `base` included. A request-rendered route under a folder no collection is served from returns not found and logs why. A request-rendered collection's `index` page is listed in the sitemap, search and route checks at the collection's URL (`/products/kit/`), not `/products/kit/index/`.
- In `astro dev`, moving, adding or removing a collection's route file restarts the server onto the new URLs and logs the redirect to add. Editing a route's template doesn't restart.
- With the nested `[...section]/llms.txt` route, a collection at a nested URL is linked from the `llms.txt` of the section above it, not only from the root `llms.txt`.
