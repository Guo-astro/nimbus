---
"@cloudflare/nimbus-docs": patch
---

- `add adapter-cloudflare` in a coding agent session wires the adapter as it does from a shell; the agent gets the recipe only where the CLI can't edit the config safely.
- `check` reports a missing `@scalar/openapi-parser` for sites with API collections, and `check --fix --yes` installs it.
- Without a terminal, `check` suggests `--fix --yes` or editing by hand, whichever `--fix` can do; `migrate --print` on a preview build says reviews start on a release.
