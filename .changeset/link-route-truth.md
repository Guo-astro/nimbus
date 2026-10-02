---
"@cloudflare/nimbus-docs": patch
---

`nimbus/internal-link` can now gate CI:

- `.nimbus/routes.json` lists every file the build produced, so links to `/llms.txt`, feeds, `.md` alternates, and `public/` files no longer show as broken.
- When the rule is on and `.nimbus/routes.json` is missing, isn't valid JSON, or was written by another version of Nimbus, `nimbus-docs lint` reports one error on that file and exits 1, instead of skipping the rule. When `astro build` starts, it deletes the previous build's file, or marks it incomplete if it can't be deleted, so lint never accepts it after a failed build. If the file can be neither deleted nor changed, the build fails until its permissions are fixed. Run `astro build` before `nimbus-docs lint`. `nimbus-docs check` is unchanged: a missing file is still a note there, not an error.
- A bare relative link such as `[CLI](cli)` now counts as a relative link, like `./cli`, instead of being looked up as `/cli`.
- **Some lint runs that passed before now fail.** Links that include Astro's `base` (for example `/docs/guide` under `base: "/docs"`) used to pass, but Nimbus adds the base again when the page renders, so they lead to `/docs/docs/guide`, a 404. Lint now reports them and suggests the link without the base. To fix them, remove the base from the link. Write `ignore` patterns without the base too.
