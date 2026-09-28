---
"@cloudflare/create-nimbus-docs": patch
---

- Templates used without the scaffolder include `nimbus.json` with the reviewed Nimbus version, so their builds no longer fail with "Nimbus has no reviewed upgrade baseline".
- New Cloudflare server sites install `@astrojs/cloudflare` 14.3, which fixes a cold-cache crash on the first `astro dev`.
- npm, yarn, and bun sites no longer include `pnpm-workspace.yaml`.
- Without a terminal, the scaffolder names the question it can't ask and suggests `--yes` or the flags that answer it, instead of failing with `uv_tty_init returned EINVAL`. Flags that answer every question work without `--yes`.
- The starter's `AGENT.md` points at the `Icon` component the starter uses, `@cloudflare/nimbus-docs/components/Icon.astro`, instead of `astro-icon`, and at `@cloudflare/nimbus-docs/content` for the docs schema. Its commands use `pnpm nimbus-docs`.
- The starter's Getting Started page shows the create command.
