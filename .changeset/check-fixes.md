---
"@cloudflare/nimbus-docs": patch
---

- `astro dev` and `astro check` no longer delete the build's page-collection list, so `nimbus-docs check` runs its page-collection checks after a build.
- `nimbus-docs lint` and `check` say when the lint rules in your Astro config changed since `.nimbus/lint.json` was written, and to run `astro sync`.
- `check` marks a scope that skipped some checks `◐ ok, partly checked`, and says `--types` covers `.ts` and `.tsx` files only (run `astro check` for `.astro`).
- `nimbus-docs check --help` lists `check`'s own flags.
- The adapter warning for `@astrojs/cloudflare` 14.2.x says only a cold `astro dev` can fail; builds aren't affected.
- An invalid API spec, such as Swagger 2.0, fails the build with its message and no stack trace.
- Request-rendered routes that export `getStaticPaths()` get one line explaining that the rendering policy renders them on request.
- On a static Cloudflare site with `trailingSlash: "always"` and `build.format: "file"`, the build and `check` warn that every `/page/` link redirects, and name the `wrangler.jsonc` fix.
- Repeated API spec warnings that differ only by source print once, with a count.
- `lint --rule nimbus/mdx-syntax` says the syntax check always runs.
