---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- A page or reusable snippet with only frontmatter builds, and its Markdown version is just its title and source.
- A snippet included inside a list item or quote keeps that structure in the page's Markdown version.
- `llms.txt` names each section for its index page's title, such as "Guides" instead of `guides`.
- Documentation search results link to the page itself instead of a URL ending in `#`, and excerpts no longer include the page actions.
- The Markdown version of an API page names each field as the page does, with its full coordinate beside it for citing.
