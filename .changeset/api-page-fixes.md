---
"@cloudflare/nimbus-docs": patch
---

- Generated API samples use `<base-url>` when a spec has no server or a relative one, instead of an invented host, and fill server variables from their defaults.
- OpenAPI 3.2 tag `parent` no longer prints a warning for each tag that uses it.
- `nimbus-docs add api-layout` ends by pointing to the API route instead of `src/components.ts`.
- The Markdown version of an API page fences cURL samples as `bash`.
