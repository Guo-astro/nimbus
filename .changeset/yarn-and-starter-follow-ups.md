---
"@cloudflare/create-nimbus-docs": patch
---

- Yarn 2+ scaffolds install. A site scaffolded with `yarn dlx` or `yarn create` pins that Yarn in `package.json` `packageManager`, and the install runs without `yarn dlx`'s Plug'n'Play hooks. Before, corepack ran Yarn 1, the install failed with `Cannot find module 'pnpapi'`, and the suggested `yarn install` made a Yarn 1 project. `--package-manager yarn` pins Yarn too, when `yarn` in the new directory runs Yarn 2+.
- A Yarn site created inside another Yarn project that doesn't list it as a workspace gets its own empty `yarn.lock` and installs, instead of failing with "doesn't seem to be part of the project". A workspace member still installs as a member.
- When Yarn holds back a release published in the last day (`YN0016`, its `npmMinimalAgeGate` setting), the install failure says so.
- Yarn sites ignore `.yarn/install-state.gz`.
- Search works on sites whose Astro `base` has no trailing slash, such as `base: "/docs"`. Before, the dialog loaded `/pagefind/pagefind.js` instead of `/docs/pagefind/pagefind.js` and said "Search is available after a production build." Existing sites can take the fix with `npx @cloudflare/nimbus-docs diff src/components/ui/search/providers/pagefind.ts --apply`.
- The empty starter's home page no longer adds a second H1 under its title.
- The starter's `AGENT.md`:
  - Its upgrade steps now pull in starter fixes with `outdated` and `diff --apply`.
  - Feature recipes run with `add <feature-slug> --print`.
  - The Cloudflare audit is split into static and server output (server sites have no `assets.directory`).
  - It says a server site's `check` stays `partial` after a build, and what to do about an error with no fix.
- The welcome page names `@cloudflare/nimbus-docs/content`.
