---
"@cloudflare/nimbus-docs": patch
---

- `add` reports components whose files already match the registry as up to date, and `--overwrite` lists each file it replaces, asking first in a terminal when you've edited the component.
- `add` no longer suggests registering a component that `components.ts` already registers.
- Upgrade reviews about API reference pages are skipped on sites without an API collection.
- `outdated` says when a newer Nimbus is out, when the reviewed version only needs recording, and when a registry dependency is installed below the version a component needs.
- `diff --apply` on a file only you changed reports there's nothing to pull, without failing.
- `diff`, `outdated` and `migrate` explain preview builds instead of asking for a baseline.
