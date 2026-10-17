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

### Route, rendering and sidebar

Do these for each new collection (`<collection>` is its name, and its URL prefix).

**Route.** Write `src/pages/<collection>/[...slug].astro`. If `src/pages/[...slug].astro`
renders a different layout than this, mirror its imports and props instead:

```astro
---
import DocsLayout from "@/layouts/DocsLayout.astro";
import {
  getCollectionStaticPaths,
  getCollectionPage,
  getSidebar,
  getPrevNext,
  getBreadcrumbs,
  getEditUrl,
  getLastUpdated,
  getRouteFlags,
  getTOC,
  stripBase,
} from "@cloudflare/nimbus-docs/runtime";
import { components } from "@/components";

export const prerender = true;
export const getStaticPaths = getCollectionStaticPaths("<collection>");

const page = await getCollectionPage<"<collection>">(Astro);
if (page instanceof Response) return page;
const { entry, Content, headings, markdownUrl, ogImageUrl } = page;

const currentSlug = stripBase(Astro.url.pathname, import.meta.env.BASE_URL).replace(/\/$/, "") || "/";
const { tableOfContents: tocOn } = await getRouteFlags(entry);
// Pass collection so the sidebar/prev-next resolve against the current
// collection's tree. Critical for version pages — without this, version
// pages render the current docs sidebar with wrong prev/next.
const sidebar = await getSidebar(currentSlug, { collection: entry.collection });
const prevNext = await getPrevNext(currentSlug, {
  sidebarTree: sidebar,
  overrides: { prev: entry.data.prev, next: entry.data.next },
});
const breadcrumbs = await getBreadcrumbs(currentSlug, { collection: entry.collection });
const editUrl = await getEditUrl(entry);
const lastUpdated = entry.data.lastUpdated ??
  await getLastUpdated(entry);
const tocConfig = entry.data.tableOfContents;
const toc = tocOn && tocConfig !== false ? getTOC(headings, tocConfig) : false;
const socialImage = entry.data.socialImage ?? ogImageUrl;
---

<DocsLayout
  title={entry.data.title}
  description={entry.data.description}
  sidebar={sidebar}
  headings={toc}
  breadcrumbs={breadcrumbs}
  prevNext={prevNext}
  mode={entry.data.mode}
  banner={entry.data.banner}
  head={entry.data.head}
  searchable={entry.data.searchable}
  noindex={entry.data.noindex}
  markdownUrl={markdownUrl}
  socialImage={socialImage}
  lastUpdated={lastUpdated}
  editUrl={editUrl}
  draft={entry.data.draft}
  collection={entry.collection}
  entryId={entry.id}
>
  <Content components={components} />
</DocsLayout>
```

**Rendering.** If the Nimbus config sets `rendering` (a Cloudflare site with server output sets
`rendering: { default: "request" }`), add the collection to `rendering.collections`, or the
build fails: `collections: { <collection>: "request" }` (or `"build"` to prerender it). Without
a `rendering` option, skip this.

**Sidebar.** Ask the user whether the collection goes in the sidebar, and where. If the Nimbus
config has `sidebar.items`, add `{ label: "<Display Name>", autogenerate: { collection: "<collection>" } }`.
If it has none, the sidebar shows only `docs` today, and adding `sidebar.items` replaces that
default: add both, `{ label: "Docs", autogenerate: { collection: "docs" } }` first.

**Section tab.** The collection's own URL (`/<collection>/`) is its `index.md`. If it has none,
tell the user the starter's section tab for it will 404, and suggest adding an index page.


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
building with `<NAME>_DOCS_REF` set to the pull request's head commit, or on
GitHub its full ref name `refs/pull/<number>/head` (a `ref` starting with
`refs/` is used as written).
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
   It reads `.mdx`, and says how many `.md` pages that leaves out.

**Report to the user:** the source, the pinned commit and how to move it, the collections and
their URLs, any build warning about links that stay as written (they point at files the site
doesn't publish), a missing index page, and whether CI needs a credential.

## Notes for the agent

- Pages need no frontmatter: one without a `title` takes its first heading,
  else its file name. Relative links between the collection's pages
  (`2-options.md#signal`) become page URLs; a relative link to a file the
  collection doesn't publish (`../readme.md`) stays as written and the build
  warns. Tell the user about those warnings rather than rewriting their docs.
- Caching `.nimbus/sources` in CI: key the cache on the ref, so preview builds
  don't prune production's snapshot.

- MDX from the source runs at build like local MDX, including its imports.
  On a repository the user doesn't control, pin a commit.
- The dev server resolves the source when it starts and keeps that snapshot's
  files; restart it to follow a branch that has moved.
- Snapshots are cached under `.nimbus/sources/`; caching that folder between
  CI runs saves the fetch.
