---
"@cloudflare/nimbus-docs": patch
---

**Behavior changes**

- The duplicate-route check uses a page's frontmatter `slug`, so `a.mdx` with `slug: b` next to `b.mdx` now fails the build, as other duplicate routes do. Before, the collision went unreported and Astro served one of the two pages.
- `withBase("/", base)` returns the base without a trailing slash, such as `/docs`, when page URLs have none: under `trailingSlash: "never"`, or `build.format: "file"` with `"ignore"`. Code that appends to the result or compares it with `/docs/` needs updating.

**`check` and `init`**

- `check` warns when an installed Astro adapter is outside the range Nimbus supports, such as `@astrojs/cloudflare` 14.1, with the command that installs a supported version. It doesn't change the version itself.
- On a PR preview, `check` names what the missing upgrade baseline needs instead of repeating "run a build, then check again".
- `init --force` keeps the recorded `lastReviewedNimbusVersion`, so rebuilding `nimbus.json` no longer brings back the "no reviewed upgrade baseline" build failure.

**`build.format: "file"` and `base`**

- With `build.format: "file"`, canonical URLs and `og:url` no longer end in `.html`, pages get previous and next links, the sidebar marks the current page, and breadcrumbs show page titles instead of "Welcome.Html".
- With a `base` and no trailing slashes, the home link, "Home" breadcrumb, and 404 page link to `/docs`, matching the home page's canonical URL, instead of `/docs/`.

**Routes and Markdown**

- In per-page `.md` files and `llms-full.txt`, a code block in a nested list item stays in the item, so the text after it no longer turns into code, and a code block in a numbered item no longer splits the list.
- The version switcher and missing-page redirects find pages in folders with dots, such as `1.2.3/`, without a `slug`, and section index pages such as `guides/index.mdx`. A `previousSlug` written as a file path, such as `guides/index`, names the section's page.
