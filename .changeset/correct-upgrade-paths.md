---
"@cloudflare/nimbus-docs": patch
---

Fix upgrade checks and CLI guidance.

**Behavior changes**

- `nimbus-docs check` warns about the placeholder `site` instead of exiting `1`, matching the build. A CI job that relied on `check` failing for an unset `site` needs its own check.
- `migrate --dry-run` and `migrate --json` report `passed` and exit `0` when no migrations or required reviews remain and a baseline is recorded, including when no entries fall between the recorded and installed versions.

**Upgrades**

- Sites upgrading from before 0.13.0 with a custom loader on a collection Nimbus indexes now see the 0.13.0 `withNimbusMarkdown()` requirement in `migrate` and `outdated`.
- `outdated --json` adds `summary.requiredPackageApis`, the required subset of `summary.packageApis`, and a `warnings` array. It warns when the compared starter needs a newer package than the project has, which also blocks `diff --apply`.
- `outdated` and `migrate` use the same terms: migrations and upgrade reviews. `migrate` prints each outcome once, and declining its record prompt says how to record the baseline later.

**CLI**

- Upgrade and migrate hints, and the build errors that point at `migrate` or `init`, print a runnable command instead of a raw Node path or a bare `nimbus-docs`. pnpm and Yarn projects that declare the package get the local bin, such as `pnpm nimbus-docs migrate`. With `--cwd`, the command is the one to run from the current directory.
- After `check --fix` without a terminal, the hint says what the remaining fixes need: a terminal for prompts, or `--yes` for installs.
- `check` lists what it skipped when the `api` config or the rendering policy isn't a plain literal, or when `src/content.config.ts` is missing.
- `lint --help` lists the lint rules and the `--color` and `--no-color` flags.
- `add` suggests registering only the component you asked for in `src/components.ts`, not its dependencies.

**Cloudflare**

- `add adapter-cloudflare` installs `@astrojs/cloudflare` 14.3, which fixes a crash on the first `astro dev` with a cold cache ("Dev server process exited before becoming ready"). Existing sites can upgrade with `pnpm add @astrojs/cloudflare@~14.3.0`.
- `add adapter-cloudflare` names the policy it adds: `rendering: { default: "request" }`, which renders every collection on request. To render only API pages on request, set that policy before running the installer, which keeps an existing policy.
