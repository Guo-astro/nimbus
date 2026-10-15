---
"@cloudflare/nimbus-docs": patch
---

- The API catalog and `ard.json` list every visible API version: a query-addressed version at its query URL, and `bundle: false` versions, whose specs are now published too.
- Homepage `Link` headers advertise only API family defaults and link to the complete catalog, keeping response headers independent of version count.
- `AgentApiPublication.markdownUrl` is optional: versions without a Markdown reference have none.
