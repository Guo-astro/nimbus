---
"@cloudflare/create-nimbus-docs": minor
"@cloudflare/nimbus-docs": minor
---

- New sites' share cards show the site's logo, the page's section and its title, on white. A long title shrinks before it's cut and stays within three lines.
- The card's look lives in the site's `src/pages/og/_card.ts`; the logo is drawn once, in `src/components/logo.ts`, for the header and the cards.
- `@cloudflare/nimbus-docs/og` fits text by measuring it and renders cards to PNG. It needs `satori` and `@resvg/resvg-js`, optional peers.
- `getPageSection(page)` returns the label of a page's nearest parent, from the sidebar for docs pages and from the spec for API pages.
