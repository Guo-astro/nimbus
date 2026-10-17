---
"@cloudflare/nimbus-docs": minor
---

- A labeled `{ autogenerate: { collection } }` group links its label to the collection's landing page at any depth. A collection served one segment deep, such as `/sdk`, now gets the link, previous and next links, and a linked breadcrumb; set `sidebar.group.hideIndex: true` on its `index` page to keep a plain heading.
