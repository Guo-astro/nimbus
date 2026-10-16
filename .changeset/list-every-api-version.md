---
"@cloudflare/nimbus-docs": patch
---

- The API catalog and `ard.json` list every visible API version: a query-addressed version at its query URL, and the non-default versions of a `bundle: false` collection, whose specs are now published too.
- Homepage `Link` headers advertise only API family defaults and link to the complete catalog, keeping response headers independent of version count.
- `AgentApiPublication.markdownUrl` is now optional, because versions without a Markdown reference have none. Code that reads it from `@cloudflare/nimbus-docs/types` or `virtual:nimbus/agent-capabilities` must handle `undefined`.
