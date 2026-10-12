---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- `og:image:width` and `og:image:height` describe the image: generated cards stay 1200 × 630, a `socialImage` file in `public/` is measured at build time, and any other image gets no size tags. `NimbusHead` takes `socialImageSize` to set them for an image Nimbus can't measure.
- The sitemap has `<lastmod>` on every documentation page, from frontmatter `lastUpdated` or the page's last commit, and `/sitemap.xml` is a copy of `sitemap-index.xml` unless the site serves its own.
- The starter's `BaseLayout` passes `socialImageSize` through to `NimbusHead`, and the 404 page recipe writes the new title and `noindex`.
- On a shallow clone, pages get no git dates instead of the wrong one, and the build says how to fetch the history.
- The 404 page's title is `Page not found | <site>` and the page is `noindex`.
