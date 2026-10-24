---
"@cloudflare/nimbus-docs": patch
---

Authored `x-codeSamples` are highlighted in any language the bundled Shiki knows, matched case-insensitively, so `hcl`, `rust` or `Shell` samples no longer render as plain text. A `lang` Shiki does not know still renders as plain text.
