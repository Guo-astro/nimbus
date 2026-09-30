---
"@cloudflare/create-nimbus-docs": patch
---

- Sites scaffolded with Yarn 2+ (`yarn dlx`, `yarn create`, or `--package-manager yarn` when `yarn` in the new directory runs Yarn 2+) pin that version in `package.json` `packageManager`, and the install runs without the parent's Plug'n'Play hooks. Before, corepack ran Yarn 1 for the install, which failed under `yarn dlx` with `Cannot find module 'pnpapi'`, and the suggested `yarn install` turned the site into a Yarn 1 project. Yarn sites also get an empty `yarn.lock`, so a site created inside another Yarn project installs as a project of its own instead of failing with "doesn't seem to be part of the project".
- Search works on sites whose Astro `base` has no trailing slash, such as `base: "/docs"`. Before, the dialog loaded `/pagefind/pagefind.js` instead of `/docs/pagefind/pagefind.js` and said "Search is available after a production build." Existing sites can take the fix with `nimbus-docs diff src/components/ui/search/providers/pagefind.ts --apply`.
- The empty starter's home page no longer adds a second H1 under its title.
- The starter's `AGENT.md` says to run feature recipes with `add <feature-slug> --print`, splits the Cloudflare audit into static and server output (server sites have no `assets.directory`), and says a server site's `check` stays `partial` after a build. The welcome page names `@cloudflare/nimbus-docs/content`.
