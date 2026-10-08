---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- A request-rendered API family can set `versionMode: "query"`: one URL per operation, the version in `?api-version=` (absent means the default, unknown is 404, hidden versions reachable by query only). Generated same-version links carry the query; discovery covers the default version at version-free URLs; non-default pages are `noindex` with the default counterpart as canonical. Path mode stays the default and is byte-identical.
- API version ids may contain dots, and must start and end with a letter or digit.
