---
{
  "name": "from-url",
  "type": "registry:source",
  "title": "Any other provider",
  "description": "Write a loader for a provider Nimbus doesn't ship, starting from its documentation URL.",
  "url": true
}
---

# Add a content source Nimbus doesn't ship

You are helping the user build part of their Nimbus docs site from a
provider Nimbus has no source for: a CMS, a knowledge base, an internal API.
The `Research start:` line above this heading is the provider's
documentation the user pointed you at; read it first, for authentication,
listing pages, and fetching each page's content.

**If that URL is a git repository** (a GitHub, GitLab or Bitbucket URL, or
any `.git` remote), stop: run `nimbus-docs add source git --print` and follow
that guide instead. Nimbus checks git repositories out itself.

## What you will build

An Astro content loader in `src/loaders/<provider>.ts`, wrapped with Nimbus's
`withNimbusMarkdown()`, registered as a collection. Wrapped, its pages get
routes, the sidebar, Markdown twins, `llms.txt`, search, API citations,
authored links and URL collision checks, like any local page. Pages are
Markdown only: no MDX components, no callouts, no edit link, no git date.

## 1. Discovery (read-only)

1. Find the Nimbus config (`defineNimbusConfig(` in `astro.config.ts` or
   `nimbus.config.ts`) and read `src/content.config.ts`.
2. From the provider's docs: how to authenticate (an API token in an
   environment variable, never in the code), how to list the pages, how to get
   one page's content, and whether the content is Markdown, HTML or blocks.

## 2. The loader contract

Write a loader whose `load({ store, parseData, renderMarkdown, generateDigest, logger })`:

1. **Fetches everything before writing anything.** Collect every page first;
   if a request fails after retries, throw. The store keeps its last good
   content in dev, and a build fails instead of publishing half a site.
2. **Derives each entry's id** from a slug field, else the slugified title.
   An empty id is an error naming the provider's page id.
3. **Checks duplicates before writing:** two pages with one id is an error
   naming both provider page ids. Nimbus can't tell a duplicate from an
   update in a loader with no files, so the loader must.
4. **Writes each entry** with `data` parsed through `parseData` (title,
   description, `sidebar.order`, and `draft: true` for unpublished pages,
   which Nimbus shows in dev and drops from production), the Markdown `body`,
   `rendered: await renderMarkdown(body)`, and `digest: generateDigest(body)`.
5. **Deletes every stored id** that isn't in the new set.
6. Lowers HTML or blocks to Markdown, escaping text so a `{`, `<` or `*` an
   editor typed renders as written.

Wire it:

```ts
// src/content.config.ts
import { docsCollection, withNimbusMarkdown } from "@cloudflare/nimbus-docs/content";
import { providerLoader } from "./loaders/provider";

handbook: defineCollection({
  loader: withNimbusMarkdown(providerLoader({ /* options */ })),
  schema: docsCollection().schema,
}),
```

Then run `nimbus-docs add new-collection --print` and follow only its steps
**"4c. Scaffold the page route"**, **"4d. Add the collection to the rendering
policy (if one is set)"** and **"6. Optional — add to the sidebar"**.

## 3. Verify against a local collection

1. Put one page's Markdown in `src/content/docs/parity-check.md` and the same
   page in the provider. Build, and compare the two pages' HTML and their
   `index.md` twins: they should match apart from the URL prefix.
2. A page with an `api.ref:` citation resolves to the API page.
3. Make two provider pages share a slug: the build fails naming both.
4. Unpublish a page: it shows in `astro dev` with the Draft badge and is
   absent from `astro build`.
5. Remove the token: the build fails naming the environment variable.
6. Delete the parity page afterwards.

## Notes for the agent

- `nimbus-docs lint` and `check` read files on disk, so they don't see this
  collection; they name it as not inspected.
- Rebuild the site when the provider's content changes: a webhook from the
  provider to the deploy hook, or a schedule.
