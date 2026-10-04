---
"@cloudflare/create-nimbus-docs": patch
---

The `api-code-rail` component keys its sample picker by sample `id`, so several samples in one language each get their own option. It remembers the reader's language, not the exact sample: a saved language opens that language's first sample, and the choice syncs across open tabs. `?lang=` accepts a sample id or a language. With packages before 0.16.0, which give samples no `id`, the picker keys by language as before.

`api-code-rail` is distributed through the registry, not the scaffolded template. Existing sites update it with `nimbus-docs add api-code-rail`, choosing Overwrite for `ApiCodeRail.astro` and `code-rail.client.ts`.
