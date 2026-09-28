---
"@cloudflare/nimbus-docs": patch
---

Make generated links, the sitemap, and Markdown output follow the site config.

**Behavior changes**

- Under the default `trailingSlash: "ignore"`, `api.ref` citation links now end in `/`, like sidebar links, in pages, per-page `.md` files, and `llms-full.txt`. They no longer 404 in `dev` and `preview`.
- With `trailingSlash: "ignore"` and `build.format: "file"` or `"preserve"`, generated links no longer end in `/`, matching the URLs Astro builds.

**Links, sitemap, and routes**

- Sidebar, navigation, breadcrumb, pagination, and citation links follow Astro's `trailingSlash` and `build.format`, so they match the canonical URL. Under `"never"` they drop the slash.
- `noindex: true` pages are left out of the sitemap on sites without `base`, as they already were with `base`.
- The docs schema accepts Astro's `slug` frontmatter field, so a page in a `1.2.3/` folder can keep its dots: `slug: 1.2.3/setup` serves it at `/1.2.3/setup/`.
- API pages no longer return 500 ("missing prepared page data") in `astro dev` after the Astro config switches to server output while the dev server is running, for example after `add adapter-cloudflare`.

**Generated Markdown**

- Per-page `.md` files and `llms-full.txt` keep the indentation of code blocks in MDX pages, so YAML and Python keep their meaning. Code inside `<Aside>` gets the `> ` prefix on every line.
- A citation inside a longer fence, such as a ```` fence that shows a ``` example, stays literal.
- `<PackageManagers>` Markdown includes the package for every `type` and matches the HTML commands. `type="dlx" pkg="@cloudflare/nimbus-docs" args="list"` now renders `npx @cloudflare/nimbus-docs list` instead of `npx list`.

**Recipes**

- The `api-reference` recipe no longer appends ` · API` to the overview page title; leaf pages keep it. Sites that installed the recipe can change the title in `src/pages/api/[...slug].astro` to ``title={page.kind === "api" ? page.title : `${page.title} · API`}``.
