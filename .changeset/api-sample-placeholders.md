---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Generated API code samples show `<name>`, such as `<account_id>`, for a path parameter whose schema declares no value, instead of `string` or a made-up UUID. Other parameters keep the value generated from their schema. A parameter's own `example` or `examples` now wins over its schema, as OpenAPI specifies. Credential placeholders now say what goes there: `Bearer <token>`, `Basic <credentials>`, and the API key's name, such as `<X-API-Key>`. Placeholders render unencoded in every language, including names that URL encoding would change, such as `filter[name]`. Declared values, including ones that look like a placeholder, and request bodies are unchanged.

Every authored `x-codeSamples` entry is now kept, including several with the same `lang`; previously only the first entry per language was shown. Each sample has an `id`, unique within the operation: the language for the first sample in that language, then `python-2`, `python-3`. The `api-code-rail` registry component keys its picker by `id`, so several samples in one language each get their own option. It remembers the reader's language, not the exact sample, across operations, and `?lang=` accepts a sample id or a language. Run `nimbus-docs add api-code-rail` to update it; see the upgrade entry.

Add `samples.keepGenerated` to `api` entries, so an operation with authored `x-codeSamples` can still show generated samples. Kept samples follow the authored ones, and an authored sample in the same language replaces the generated one. The default, `[]`, keeps today's behavior.

```ts
api: [{ collection: "api", spec: "./src/api/openapi.yaml", samples: { keepGenerated: ["curl"] } }],
```
