---
"@cloudflare/nimbus-docs": minor
---

- A collection is served where its route file is: `src/pages/products/sdk/[...slug].astro` serves `sdk` at `/products/sdk`, and every URL Nimbus builds follows: pages, sidebar, Markdown versions, `llms.txt`, sitemap, search, social cards, and for an API its versions, `openapi.json` and catalog entry. Sites whose route folders match their collection names build the same output.
- `getCollectionUrl(collection)` returns where a collection is served, for links in components. A name that isn't a page collection throws.
- `nimbus-docs check` lists where each collection is served when a route moves one; `check --json` always includes it.
- Sites that build broken URLs today now fail with an error naming the file and the fix: several routes for one collection with none at its default URL, two collections on one URL, a collection served only from dynamic folders, a docs or version route away from its URL, a page under another collection's moved URL, an API collection at the site root, a route helper in a route whose parameter isn't `slug` (`[...path].astro`), or a route helper running in a route its collection isn't served from.
- A sidebar `prefix` for a collection served by a route helper is deprecated: the route sets the URL.
- `getIndexedTopLevel()` groups a moved collection under its URL: a group's `slug` and `label` can contain `/` (`products/sdk`). Components that build `/${slug}/llms.txt` or show `label` should expect it.
- Two new warnings, from the build and `check`: a second static route for a collection that's already served elsewhere (its pages duplicate the collection's), and a helper route in a nested folder whose `getStaticPaths` Nimbus can't read.
- `nimbus-docs lint` follows the pages Astro writes for a dynamic redirect (`"/sdk/[...slug]": "/products/sdk/[...slug]"`) instead of taking them for pages, so a redirect to a missing page is reported and `nimbus/redirected-link` finds links through it.
- `nimbus-docs lint` suggests the new URL for a link into a moved collection (`/sdk/setup` → `/products/kit/setup`), and never suggests the site root or an error page as a near-match. Builds record each collection's URL in `.nimbus/routes.json` for this.
- `nimbus-docs check` checks collections added since the last build, alongside the ones that build recorded.
