---
"@cloudflare/nimbus-docs": patch
---

- `nimbus/image-ref` checks image paths under Astro's `base`: an inline image needs the base written and a reference definition must not repeat it. `lint --fix` repairs both when the file is in `public/`. Its `ignore` patterns are written without the base, as for links.
- Under a base, `nimbus-docs lint` now reports inline images written without it, such as `/arch.png`, which can fail CI where it passed before. Those images return 404 on the deployed site.
