---
"@cloudflare/nimbus-docs": patch
---

- `outdated` and `diff` also compare `AGENT.md`, `CLAUDE.md`, and `tsconfig.json` with the upstream starter, so upgraded sites get guidance fixes. Files every site rewrites, such as `package.json`, are never compared.
- `diff <file> --apply` records the tag it took the file from in `nimbus.json` (`templatesTagByFile`), so the file no longer shows as a hand-merge after the next upstream change.
- Each command rejects flags it doesn't read. Before, `outdated --cwd site` ignored `--cwd` and checked the current directory. Scripts that pass an ignored flag now exit 1.
- `check` and `add adapter-cloudflare` use `@astrojs/cloudflare@~14.3.0`. pnpm saved the old `>=14.3.0 <14.4.0` as `^14.3.x`, which allows 14.4.
- `add` and `init` print plain lines without a terminal, instead of spinner escapes.
- A duplicate page or unknown MDX component fails the build without a stack trace.
- Generated Markdown keeps list structure around components: code blocks and nested lists stay in their list items, and components stay inside the list item, card, or blockquote that holds them.
- Components without a Markdown renderer no longer leave raw tags; a `title` becomes a bold line.
