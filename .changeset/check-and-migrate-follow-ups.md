---
"@cloudflare/nimbus-docs": patch
---

- `migrate` refuses to record a reviewed version when the project's `@cloudflare/nimbus-docs` isn't installed, and says to install dependencies. Before, `npx @cloudflare/nimbus-docs migrate --yes` in a fresh clone recorded the latest release while the lockfile installed an older one, and the build then failed with advice that failed too.
- When `nimbus.json` records a version newer than the installed one, the build error says to install dependencies or upgrade, with the command, instead of suggesting `migrate`.
- `migrate --dry-run --diff` with nothing pending prints the same result and next step as `migrate --dry-run`, instead of nothing.
- Before the first install, `check` reports one "Dependencies aren't installed" error with the install command, instead of offering to install pagefind and wrangler one at a time.
- After `check --fix` without a terminal, the footer names `check --fix --yes` for skipped installs, and says a value such as `site` needs editing by hand or an interactive terminal. Before, it only said to rerun `check --fix` "in a terminal", even for installs.
- `check --help` gives the same stop rule as the starter's `AGENT.md`: stop when no finding has a fix that doesn't need input.
- The `nimbus/request-rendering-build-required` note no longer claims a build resolves it. `check` doesn't verify request-rendered pages; a passing production build is the gate.
- Under `trailingSlash: "always"` with `build.format: "file"`, canonical and `og:url` URLs keep the trailing slash, matching page links. Before, they pointed at URLs without it, which 404.
- `<PackageManagers type="exec">` runs the project's installed CLI with every package manager: `pnpm nimbus-docs` and `yarn nimbus-docs` for a scoped package, instead of `pnpm @cloudflare/nimbus-docs`.
