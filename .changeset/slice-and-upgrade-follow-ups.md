---
"@cloudflare/nimbus-docs": patch
"@cloudflare/create-nimbus-docs": patch
---

- `add adapter-cloudflare` on a pnpm site declines workerd's build script first, so the install no longer fails.
- A slice's Markdown images are published under its prefix, and Markdown images load in `astro dev`.
- WebMCP search covers every slice, like the search dialog. On an existing site, pass `searchIndex` to it as the starter's `WebMCP.astro` does.
- Search excerpts for request-rendered pages read as text, not Markdown syntax.
- `add --overwrite` names the files that carry your edits.
