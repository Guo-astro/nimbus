---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- A page collection's files can live anywhere: a glob over a folder outside `src/` gets callouts, components, citations, links, collision checks and lint like a page under `src/content`.
- A loader with no files gets citations, links, Markdown versions, `llms.txt` and URL collision checks through `withNimbusMarkdown()`.
- Two files with one slug fail the build in any collection, `.md` files included; in collections made with the factories, so does a byte-identical copy.
- `sources` in the Nimbus config checks out another git repository at build time; `docsCollection({ source, base })` and `api[].spec: { source, path }` read it.
- A pinned commit is fetched once and builds offline; a branch builds from its last snapshot when the remote is down.
- `NIMBUS_BUILD_ONLY` fetches only the sources its collections and `api` entries read; `astro dev`, `astro sync` and `astro preview` start without a source they can't fetch, leaving its collections empty, while `astro build` fails naming what reads it.
- A `repo` with a token or password in it is refused; credentials come from git.
- Pages from a source get the source's `editPattern` and no git date.
- `nimbus-docs check` reports `nimbus/source-floating-ref` and `nimbus/source-unreferenced`.
- `nimbus-docs lint` reads source snapshots and reports problems by source and repository path; `--fix` never writes them.
- `nimbus-docs add source <name|url>` adds a content source: `git` (`github`, `gitlab`, `bitbucket`), `notion`, or a guide for any provider from its docs URL.
- `add source notion` installs a Notion loader with drafts, slugs and ordering from the database's properties.
- `list --type source` lists the sources.
