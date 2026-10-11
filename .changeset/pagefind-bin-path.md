---
"@cloudflare/nimbus-docs": patch
---

- Search is indexed however `astro build` is started, including `./node_modules/.bin/astro build`.
- A site's `pagefind.yml` applies when the build starts from another folder with `--root`.
- The build says to install Pagefind only when it isn't installed.
