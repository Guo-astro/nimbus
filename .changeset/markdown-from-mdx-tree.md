---
"@cloudflare/nimbus-docs": patch
---

- Generated Markdown (`.md` pages and `llms-full.txt`) is built from the parsed MDX, so it keeps the structure the HTML page shows: code blocks and nested lists stay in their list items, components stay inside the list item, card, or blockquote that holds them, and nested components keep their own content.
- Components without a Markdown renderer no longer leave raw tags.
- Text MDX reads differently from Markdown, such as an indented line or an over-indented fence, is written so it reads the same.
