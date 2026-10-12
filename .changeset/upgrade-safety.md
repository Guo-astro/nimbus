---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- `add --overwrite` without a terminal keeps components you've edited, dependencies included, lists them with the commands that replace them, and exits 1; `--overwrite --yes` replaces them and says how many carried edits.
- `add a b` installs both; an unknown slug stops before anything is installed.
- `check` says an optional upgrade stays listed until `migrate` records the version as reviewed.
- New pnpm sites build pages with local images: `sharp` is a starter dependency.
- `astro build --root <site>` from another folder finds the social-card font.
- Docs: banner `content` is HTML inserted as written; a required review stops `astro dev --background` silently, so run `astro dev logs` or `nimbus-docs check`.
