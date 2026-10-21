# @cloudflare/create-nimbus-docs

Create a [Nimbus](https://nimbus-docs.com) docs site.

Requires Node.js 22.12.0 or later.

```sh
npx @cloudflare/create-nimbus-docs@latest my-docs
cd my-docs
npm run dev
```

It writes an Astro docs site into `my-docs`: layouts, components, styles, routes and example pages, as plain files you can edit. It asks where you'll deploy and whether to include the example pages.

## Options

- `--yes`, `-y`: skip the questions. You get the example pages, a static site set up for Cloudflare, a git repository and installed dependencies.
- `--content <starter|empty>`: example pages, or none.
- `--deploy <cloudflare|other>`: where the static site deploys (default `cloudflare`).
- `--adapter <cloudflare|netlify|vercel|node>`: render pages on request with that adapter, instead of `--deploy`.
- `--package-manager <npm|pnpm|yarn|bun>`: override the one that ran the command.
- `--skip-install`, `--no-git`: skip installing dependencies or creating a git repository.
- `--template-dir <path>`: copy a local template instead of downloading one.

## Templates

Each version of this package downloads its templates from the matching `templates-v<version>` tag on GitHub, so a version always starts from the same files. That download needs access to GitHub; `--template-dir` skips it.

## Documentation

[nimbus-docs.com/quickstart](https://nimbus-docs.com/quickstart)

## License

MIT
