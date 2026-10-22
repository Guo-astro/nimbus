---
"@cloudflare/nimbus-docs": minor
---

- `docsCollection({ markdownFields })` writes the named frontmatter fields into each page's `.md` and `.mdx`.
- `NestedContent` shows another page's content inside this one, its headings below yours and its section links pointing back to its page.
- `nimbus-docs add changelog` builds release notes: 10 releases a page, a page per release, and an `@astrojs/rss` feed. Existing changelogs keep working (review entry `changelog-release-notes`).
