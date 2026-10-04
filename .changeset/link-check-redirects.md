---
"@cloudflare/nimbus-docs": minor
---

`nimbus/internal-link` follows redirects:

- Links through a working redirect pass. Nimbus reads the build's `_redirects` and Astro's `redirects`; the new `redirectsFile` integration option adds a redirects file your deployment reads under another name. A redirect to a page that doesn't exist is still a broken link.
- Redirects match the way your platform matches them: Netlify's rules with a `netlify.toml`, Cloudflare's otherwise.
- New `nimbus/redirected-link` rule (off by default) reports links that go through a permanent redirect, with the URL to use instead.
- Run `astro build` again after upgrading: `.nimbus/routes.json` has a new version.
