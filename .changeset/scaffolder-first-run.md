---
"@cloudflare/create-nimbus-docs": patch
---

**Behavior changes**

- A failed dependency install exits `1`. The scaffolder keeps the project and prints the commands that finish the setup. Before, it printed "Done" and exited `0`, so CI treated the site as ready.
- Unknown flags, such as `--output server`, stop the scaffolder with the list of valid flags. Before, they were ignored and the site was scaffolded without them.
- `--git` with `--no-git`, and `--deploy` with `--adapter`, stop the scaffolder. Before, `--no-git` won and `--deploy` was ignored with a warning.
- A second directory argument stops the scaffolder. A leading `--`, as pnpm passes it through, is accepted, so `pnpm dlx … -- my-docs --yes` no longer ignores `--yes`.

**First run**

- `yarn dlx` with Yarn 2+ can scaffold from a PR preview. Yarn now extracts the package instead of keeping it in a zip, where the preview's bundled templates couldn't be read.
- Pressing Enter at the directory prompt uses `my-docs`, as shown. Before, it failed with "Directory is required".
- bun's install output no longer shows in the scaffolder's output, and "Next steps" no longer has an empty line where the install command would be. An install's own output shows only when it fails.
- The empty starter ships one home page, `src/content/docs/index.mdx`, so its first `nimbus-docs check` no longer warns about a duplicate route at `/`. Before, a landing page shadowed it and linked to pages the empty starter doesn't have.
- The starter's home page links to its pages through their entries, so the links follow `trailingSlash` and a card whose page you delete disappears instead of linking to a 404.
- The starter's `AGENT.md` says to set `site` before running `check` in a loop, and ends the loop when only fixes that need input remain, so an agent no longer loops on the placeholder `site`. It also says components can be imported in the `.mdx` file that uses them instead of registered.
