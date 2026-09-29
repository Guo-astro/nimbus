---
"@cloudflare/create-nimbus-docs": patch
---

- Templates used without the scaffolder include `nimbus.json` with the reviewed Nimbus version, so their builds no longer fail with "Nimbus has no reviewed upgrade baseline".
- npm, yarn, and bun sites no longer include `pnpm-workspace.yaml`.
- Yarn sites get a `.yarnrc.yml` with `nodeLinker: node-modules`. Before, Yarn 2+ installed in Plug'n'Play mode, and the site failed to build or start the dev server.
- Unknown `--content` and `--package-manager` values are rejected with the valid choices. Before, a typo such as `--package-manager pnmp` scaffolded a site with no install and still printed "Done".
- Without a terminal, the scaffolder names the question it can't ask and suggests `--yes` or the flags that answer it, instead of failing with `uv_tty_init returned EINVAL`. Flags that answer every question, including `--git` or `--no-git`, work without `--yes`.
- The starter's `AGENT.md` points at the `Icon` component the starter uses, `@cloudflare/nimbus-docs/components/Icon.astro`, instead of `astro-icon`, and at `@cloudflare/nimbus-docs/content` for the docs schema. Its commands use `pnpm nimbus-docs`.
- The starter's Getting Started page shows the create command.
