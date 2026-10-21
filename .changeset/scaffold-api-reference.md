---
"@cloudflare/create-nimbus-docs": minor
---

- A new site can include an API reference: `--api` adds one at `/api`, from your OpenAPI 3.x file (`--api ./openapi.yaml`) or a sample, and `--template api` makes it the whole site, at `/`. Without flags, the scaffolder asks what the site includes, and it refuses a spec that isn't OpenAPI 3.x before writing anything.
- `AGENT.md` in a site with an API reference says where its spec and route are; a site that is only the reference has no docs-writing sections.
- The starter's header shows Docs and API reference tabs when a site has an API reference beside its docs.
