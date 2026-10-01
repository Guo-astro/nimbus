---
"@cloudflare/nimbus-docs": patch
---

- A `markdown.componentMap` renderer's output goes into generated Markdown as written again (apart from surrounding whitespace), unless it uses another component, which still converts. In a table cell or a sentence, output with a line break or `|` is converted so the cell or sentence stays whole.
- A page whose MDX can't be parsed for generated Markdown keeps its text there, with a warning, instead of failing the build.
