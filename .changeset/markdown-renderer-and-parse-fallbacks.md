---
"@cloudflare/nimbus-docs": patch
---

- A `markdown.componentMap` renderer's output goes into generated Markdown exactly as written again, unless it uses another component, which still converts.
- A page whose MDX can't be parsed for generated Markdown keeps its text there, with a warning, instead of failing the build.
