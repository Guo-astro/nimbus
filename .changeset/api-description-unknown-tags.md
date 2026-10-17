---
"@cloudflare/nimbus-docs": patch
---

- API descriptions keep text the HTML sanitizer doesn't know as a tag, such as `metadata.<key>`, as text instead of dropping it. `<script>` is still removed, and other unknown tags render as inert text.
