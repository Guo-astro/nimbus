---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- With the section route at `src/pages/[...section]/llms.txt.ts`, each sub-folder gets its own `llms.txt`, and its parent's index links to it under "Sections". New sites have this route; a `[section]` route keeps today's one index per top-level section.
- An `llms-full.txt` over 25 MiB becomes an index of one `llms-full.txt` per section, split further where a section is still too big, so the site deploys to Cloudflare.
- `LlmsEndpointReference` (from `@cloudflare/nimbus-docs/agent-endpoints`) adds `surface: "full"` on section references, for the per-section `llms-full.txt` files.
