---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- Agent files follow the rendering policy: a page's `index.md`/`index.mdx` renders in its collection's mode, a section's `llms.txt` in the mode of the collection it lists, `llms.txt`/`llms-full.txt` in `rendering.default`, and homepage Markdown in the root collection's mode. Mounted collections get their own agent routes, copied starter routes keep working unchanged, and static sites don't change.
