---
"@cloudflare/nimbus-docs": patch
---

- The API catalog, `ard.json` and the homepage `Link` header list every visible API version: a query-addressed version at its query URL, and `bundle: false` versions, whose specs are now published too.
- `AgentApiPublication.markdownUrl` is optional: versions without a Markdown reference have none.
