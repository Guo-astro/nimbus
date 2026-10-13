---
{
  "name": "git",
  "type": "registry:source",
  "title": "Git repository",
  "description": "Pages from another git repository: a pinned commit cached locally, edit links into that repository, previews from its pull requests.",
  "aliases": { "github": "GitHub", "gitlab": "GitLab", "bitbucket": "Bitbucket" }
}
---

# Add a git repository as a content source

You are helping the user build part of their Nimbus docs site from Markdown
or MDX that lives in **another git repository** (an SDK's `docs/` folder, a
CLI's reference pages). Nimbus checks that repository out at build time; the
pages render exactly like the site's own. Nothing is copied into this
repository.

If a `Host:` line sits above this heading, it names the user's git host; use
that row of the host table below. Otherwise ask which host the repository is
on, and use the "Any other host" row if it isn't listed.

## 1. Discovery (read-only)

1. **Find the Nimbus config.** Search for `defineNimbusConfig(` (or
   `defineConfig(` imported from `@cloudflare/nimbus-docs`). It is usually in
   `astro.config.ts`, sometimes in `nimbus.config.ts` imported from there.
   Every config edit below goes into that object.
2. **Read `src/content.config.ts`** and the existing `sources` key, if any.
3. **Check `.gitignore` lists `.nimbus/`.** Snapshots live under
   `.nimbus/sources/`. A site made with the scaffolder already ignores it; a
   site adopted with `nimbus-docs init` may not. Add the line if it's missing.
4. **Check git is available where the site builds.** Run `git --version`
   locally. For CI or a hosted build, note the build image; most include git.

## 2. Ask the user

1. The repository URL (`https://…` or `git@…`, or a path to a local clone).
2. The folder inside it that holds the pages (`docs`, or `""` for the whole
   repository). This folder is the only part checked out.
3. The collection name(s) and URL prefix(es): one source can feed several
   collections, for example `sdk-guides` at `/sdk-guides` from `docs/guides`
   and `sdk-reference` at `/sdk-reference` from `docs/reference`.
4. Is the repository private? (Section 5.)

Never put a token or password in the URL. Nimbus refuses one; credentials go
to git (section 5).

## 3. Pin a commit

Resolve the branch the user wants to a full commit and use that as `ref`:

```sh
git ls-remote <repo> refs/heads/main
```

A pinned commit is fetched once and reused with no network call; the build is
reproducible and a release of the other repository never changes the docs by
surprise. A branch name also works (`ref: "main"`), but the content can change
between builds and `nimbus-docs check` reports `nimbus/source-floating-ref`.

Name the preview variable after the source: `<NAME>_DOCS_REF` in upper case,
`SDK_DOCS_REF` for a source named `sdk`. Section 6 uses it.

## 4. Edit the config and the collections

In the Nimbus config, add the source (merge into an existing `sources`):

```ts
sources: {
  sdk: {
    repo: "https://github.com/acme/sdk.git",
    ref: process.env.SDK_DOCS_REF ?? "<the 40-character commit>",
    path: "docs",
    editPattern: "<the host's edit pattern, from the table>",
  },
},
```

In `src/content.config.ts`, add one collection per mount. `base` is a folder
inside the source's `path` (default: all of it):

```ts
"sdk-guides": defineCollection(docsCollection({ source: "sdk", base: "guides" })),
"sdk-reference": defineCollection(docsCollection({ source: "sdk", base: "reference" })),
```

Then run `nimbus-docs add new-collection --print` and follow only these steps
of it, for each new collection: **"4c. Scaffold the page route"**, **"4d. Add
the collection to the rendering policy (if one is set)"** and **"6. Optional —
add to the sidebar"**. Skip its steps that create a content folder or register
the collection; that's done above.

An OpenAPI spec in the same repository can feed an API reference without a
copy: `api: [{ collection: "api", spec: { source: "sdk", path: "docs/openapi.json" } }]`
(the path is repository-relative and must sit inside the source's `path`).

## 5. Host table

| Host | `editPattern` | Private repository in CI |
|---|---|---|
| GitHub | `https://github.com/<owner>/<repo>/edit/main/{path}` | An Actions token through git's `extraHeader` (below), with a `contents: read` token for the source repository |
| GitLab | `https://gitlab.com/<group>/<project>/-/edit/main/{path}` | `CI_JOB_TOKEN` through `extraHeader`, after allowing the docs project in the source project's job token allowlist |
| Bitbucket | `https://bitbucket.org/<workspace>/<repo>/src/main/{path}?mode=edit` | An app password (or access token) with repository read, through `extraHeader` |
| Any other host | the host's own edit URL with `{path}`, or leave `editPattern` out | git's credential helper, or `extraHeader` |

`{path}` is the file's path inside the repository. Use the branch the pages
are edited on (`main` above): an edit URL with a pinned commit opens a
read-only view. `{ref}` is the configured ref, for a source that follows a
branch. Without `editPattern`, pages from the source have no edit link. Pages
from a source have no last-updated date unless their frontmatter sets
`lastUpdated`.

A public repository needs no credentials. For a private one, give the
credential to git, never to Nimbus. In CI, set git's `extraHeader` through
environment variables, which is how `actions/checkout` authenticates:

```yaml
env:
  GIT_CONFIG_COUNT: "1"
  GIT_CONFIG_KEY_0: http.https://github.com/.extraHeader
  GIT_CONFIG_VALUE_0: "Authorization: Basic ${{ secrets.SDK_DOCS_BASIC_AUTH }}"
```

where the secret is the base64 of `x-access-token:<token>` (GitHub),
`gitlab-ci-token:<token>` (GitLab), or `x-token-auth:<access token>` or
`<username>:<app password>` (Bitbucket).
Locally, git's credential helper or an SSH remote (`git@…`) already works.

## 6. Previews from the source repository

A pull request in the source repository can preview its docs on this site by
building with `<NAME>_DOCS_REF` set to the pull request's commit (or branch).
Set the variable in the docs site's preview build, for example from a
workflow in the source repository that triggers the docs site's deploy hook
with the commit. For a private source, the preview build needs the same read
credential as production.

## 7. Verify

1. Run the build. The log names the source and the commit it fetched.
2. Open a page from each new collection; check its edit link opens the right
   file in the source repository.
3. Run `nimbus-docs check`: no `nimbus/source-unreferenced` (every source is
   read by a collection or a spec). A `nimbus/source-floating-ref` warning
   means `ref` is a branch; pin a commit for production.
4. Run `nimbus-docs lint`: problems in the source's pages are reported as
   `sdk: docs/guides/intro.mdx:12`, to be fixed in the source repository.

## Notes for the agent

- MDX from the source runs at build like local MDX, including its imports.
  On a repository the user doesn't control, pin a commit.
- The dev server resolves the source when it starts and keeps that snapshot's
  files; restart it to follow a branch that has moved.
- Snapshots are cached under `.nimbus/sources/`; caching that folder between
  CI runs saves the fetch.
