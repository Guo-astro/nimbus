---
{
  "name": "notion",
  "type": "registry:source",
  "title": "Notion database",
  "description": "Pages from a Notion database: title, description, slug, order and publishing from its properties.",
  "files": ["loaders/notion.ts"],
  "dependencies": ["@notionhq/client"]
}
---

# Add a Notion database as a content source

**Before anything else, tell the user:** pages from Notion are Markdown. They
get routes, the sidebar, search, Markdown twins and `llms.txt` like any page,
but no MDX components, no callouts (a Notion callout becomes a quote with a
bold label), no edit link and no last-updated date. If they need those, the
pages belong in the repository.

`nimbus-docs add source notion` has installed `src/loaders/notion.ts` (yours
to edit) and `@notionhq/client`. You wire it up.

## 1. Discovery (read-only)

1. Find the Nimbus config (`defineNimbusConfig(` in `astro.config.ts` or
   `nimbus.config.ts`) and read `src/content.config.ts`.
2. Check `src/loaders/notion.ts` exists. If not, run
   `nimbus-docs add source notion` again.

## 2. Ask the user

1. **The database.** Its id is the 32-character hex string in the database's
   URL (`notion.so/<workspace>/<id>?v=…`).
2. **The token.** Create an internal connection at
   https://www.notion.so/profile/integrations with "Read content", then share
   the database with it (the database's `•••` menu, "Connections"). Put the
   token in `NOTION_TOKEN`: `.env` locally (check `.env` is gitignored), and
   the build's environment in CI. Never in code.
3. **The collection name and URL prefix**, for example `handbook` at `/handbook`.
4. **The publishing value.** Notion creates a status property with Not started,
   In progress and Done. Ask which value means published; if it isn't
   `Published`, pass `publishedValue` (for example `publishedValue: "Done"`).
   Otherwise every row is a draft and the build warns that nothing published.
5. **The properties.** Defaults, by name: `Description` (rich text),
   `Slug` (rich text, the page's URL; else the slugified title), `Order`
   (number, sidebar order), `Status` (status, select or checkbox; a row
   publishes when it is `Published`, or checked). Ask if theirs differ.

## 3. Register the collection

```ts
// src/content.config.ts
import { docsCollection, withNimbusMarkdown } from "@cloudflare/nimbus-docs/content";
import { notionLoader } from "./loaders/notion";

handbook: defineCollection({
  loader: withNimbusMarkdown(notionLoader({ database: "<database id>" })),
  schema: docsCollection().schema,
}),
```

Different property names: `notionLoader({ database, properties: { slug: "URL",
status: "State" }, publishedValue: "Live" })`. A database with several data
sources fails listing them; pick one with `dataSource: "<id>"`.

Then run `nimbus-docs add new-collection --print` and follow only its steps
**"4c. Scaffold the page route"**, **"4d. Add the collection to the rendering
policy (if one is set)"** and **"6. Optional — add to the sidebar"**.

## 4. What the publishing rule does

| The database | Result |
|---|---|
| No `Status` property, nothing configured | every row publishes (one info line says so) |
| `Status` present | a row that isn't `Published` (or unchecked) is a draft: shown in `astro dev` with the Draft badge, absent from `astro build` |
| A named property missing or of the wrong type | the build fails, listing the data source's properties |

Two rows with one slug, or a row with no slug and an empty title, fail the
build naming the Notion page ids. Without a `Slug`, renaming a page's title
changes its URL.

## 5. Verify

1. `astro dev`: the pages render, drafts show the badge.
2. `astro build`: drafts are gone; the build log names any block type that
   had no Markdown form.
3. Remove `NOTION_TOKEN`: the build fails naming it.

## Notes for the agent

- Notion file URLs (images uploaded to Notion) expire after an hour; images
  that must last belong on a host of their own.
- The site doesn't update when Notion does: rebuild on a schedule, or from a
  Notion webhook through an automation to the deploy hook.
- `nimbus-docs lint` and `check` don't read Notion; they name the collection
  as not inspected.
- Notion limits each connection to about three requests a second; the
  loader retries rate limits and server errors, and a build that still fails
  wrote nothing and can be rerun.
