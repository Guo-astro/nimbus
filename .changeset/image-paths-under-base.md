---
"@cloudflare/nimbus-docs": patch
---

- `nimbus/image-ref` checks image paths under Astro's `base`: an inline image needs the base written and a reference definition must not repeat it. `lint --fix` repairs both when the file is in `public/`.
