# Nimbus

**The authoring tool for docs.**

Write in your editor, your repo, or the tools your team already uses, or hand the page to an agent. Nimbus turns it into an Astro docs site whose layouts, components and content live in your repo. Every page is held to the same standard, whoever wrote it, and published for people and for agents.

Docs: [nimbus-docs.com](https://nimbus-docs.com)

## Start

Requires Node.js 22.12.0 or later.

```sh
npx @cloudflare/create-nimbus-docs@latest my-docs --yes --package-manager npm
cd my-docs
npm run dev
```

The scaffolder writes the whole site into `my-docs`: layouts, components, styles, routes and content. Start with `src/content/docs/index.mdx`.

## Pages worth reading

- MDX components for code blocks, steps, cards, tabs, reusable snippets and interactive diagrams.
- An API reference generated from an OpenAPI 3.x spec, with as many API versions as you publish.
- Search, docs versions side by side, and pages loaded from other Git repositories or Notion.

## Quality that holds

- Config, frontmatter and MDX components are validated as the site builds, with errors that name the file and what to change.
- `nimbus-docs lint` catches authoring mistakes with rules you configure in `astro.config.ts`. It reports without blocking the build, so drafts still render.
- `nimbus-docs check` looks at the environment, structure, content, types and pending upgrades without building, and `--fix` applies the safe fixes.

## Built for agents

- **Agents author.** `nimbus-docs add` copies components into your repo as source. Features arrive as recipes your coding agent reads, adapts to your project and applies, and `check --json` gives it findings to act on.
- **Any agent, or none.** Recipes are Markdown and findings are JSON, so they work with the agent you prefer, or you can follow them yourself.
- **Agents read.** Published pages have Markdown versions, the site publishes `llms.txt` and `llms-full.txt`, and it can serve Agent Skills, WebMCP search and a remote MCP server.

## Deploy

Sites are static by default: `npm run build`, then host the output anywhere. Rendering pages on request and the remote MCP server need a server adapter; see [Deploy](https://nimbus-docs.com/deploy).

## Packages

| Package | What it is |
| --- | --- |
| [`@cloudflare/create-nimbus-docs`](./packages/create-nimbus-docs) | Creates a new site. |
| [`@cloudflare/nimbus-docs`](./packages/nimbus-docs) | The Astro integration and the `nimbus-docs` CLI. |

## Status

Nimbus is pre-1.0 and moving fast. You can build real sites with it today, but the public surface can still change between minor releases. Pin your versions and read each package's changelog before upgrading.

## Contributing

Start with an issue or a discussion. Once a maintainer approves it, your pull requests go through normal review. See [CONTRIBUTING.md](./CONTRIBUTING.md), and [CLAUDE.md](./CLAUDE.md) for the architecture and agent context.

## License

[MIT](./LICENSE)
