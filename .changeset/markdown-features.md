---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- New `markdown.features` option turns on Sätteri syntax, such as `{ headingAttributes: true }` for `## Install {#install}` or `{ math: true }`. Pages, generated Markdown, reusable snippets and lint all follow it. New sites start with heading ids on.
- Generated Markdown drops `{/* comments */}`.
- Invalid MDX reports the file, line and fix instead of an internal error.
