---
"@cloudflare/create-nimbus-docs": patch
"@cloudflare/nimbus-docs": patch
---

- Server scaffolds for Node, Vercel, and Netlify render docs pages on request, so Markdown negotiation works on them.
- Scaffold into `.` or an empty folder, including a freshly cloned repository.
- New repositories get a first commit; scaffolding inside an existing repository no longer creates a nested one.
- `npm create` installs a handful of packages instead of the whole framework.
- A missing package manager fails before anything is written, and a mistyped flag suggests the right one.
- Yarn sites ignore `.yarn/` the way Yarn recommends, and pin Yarn inside a folder that pins another package manager.
- The starter's `AGENT.md` explains sidebar groups, order, and links.
- `nimbus-docs check` and `--help` show commands for your package manager.
