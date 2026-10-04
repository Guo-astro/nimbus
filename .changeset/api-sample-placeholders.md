---
"@cloudflare/nimbus-docs": minor
---

Generated API code samples show `<name>`, such as `<account_id>`, for a path parameter unless a value declared in its schema produces the generated value, instead of a guess such as `string`, `0`, or a made-up UUID. This holds for any schema shape, including `allOf`, unions, and `if`/`then`. Required query parameters and headers keep the generated value, guesses included; one with no schema, or whose generated value is an array or object, now shows `<name>` instead of its bare name. A parameter's own `example` or `examples` now wins over its schema, as OpenAPI specifies. Credential placeholders now say what goes there: `Bearer <token>`, `Basic <credentials>`, and the API key's name, such as `<X-API-Key>`. Placeholders render unencoded in every language, including names that URL encoding would change, such as `filter[name]`. Declared values, including ones that look like a placeholder, and request bodies are unchanged.

Every authored `x-codeSamples` entry is now kept, including several with the same `lang`; previously only the first entry per language was shown. Each sample has an `id`, unique within the operation: the language for the first sample in that language, then `python-2`, `python-3`. A repeated label, or a missing one that falls back to `lang`, is numbered for display (`Python (2)`) in the picker and the Markdown version. To give each of them its own picker option, update the `api-code-rail` registry component with `nimbus-docs add api-code-rail`, choosing Overwrite for its two files; see the upgrade entry `api-code-sample-ids`. Without the update, a language's samples show one after another.

Add `samples.keepGenerated` to `api` entries, so an operation with authored `x-codeSamples` can still show generated samples. Kept samples follow the authored ones, and an authored sample in the same language replaces the generated one. The default, `[]`, keeps today's behavior.

```ts
api: [{ collection: "api", spec: "./src/api/openapi.yaml", samples: { keepGenerated: ["curl"] } }],
```
