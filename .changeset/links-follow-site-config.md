---
"@cloudflare/nimbus-docs": patch
---

Make generated links, the sitemap, and Markdown output follow the site config.

**Behavior changes**

- Under the default `trailingSlash: "ignore"`, `api.ref` citation links now end in `/`, like sidebar links and the canonical URL, in pages, per-page `.md` files, and `llms-full.txt`.
- With `trailingSlash: "ignore"` and `build.format: "file"` or `"preserve"`, generated links no longer end in `/`, so they reach the pages Astro builds. The canonical URL is unchanged and still ends in `.html`.

**Links, sitemap, and routes**

- Sidebar, navigation, breadcrumb, pagination, and citation links, and the API reference's sidebar, breadcrumbs, and type links, follow Astro's `trailingSlash` and `build.format`. Under `"never"` they drop the slash, and API links no longer 404 under `"always"` or `"never"`. With the default `build.format`, they match the canonical URL.
- `noindex: true` pages are left out of the sitemap on sites without `base`, as they already were with `base`.
- The docs schema accepts Astro's `slug` frontmatter field, so a page in a `1.2.3/` folder can keep its dots: `slug: 1.2.3/setup` serves it at `/1.2.3/setup/`. The version switcher and missing-page redirects use the `slug` too.
- API pages no longer return 500 ("missing prepared page data") in `astro dev` after the Astro config switches to server output while the dev server is running, for example after `add adapter-cloudflare`.

**Generated Markdown**

- Per-page `.md` files and `llms-full.txt` keep the indentation of code blocks in MDX pages, so YAML and Python keep their meaning. Code inside `<Aside>` gets the `> ` prefix on every line.
- A citation inside a longer fence, such as a ```` fence that shows a ``` example, stays literal, as does one in a fence opened on a list-item line (`- ```yaml`). That fence also stays inside its list item in the Markdown output.
- `<PackageManagers>` Markdown includes the package for every `type` and matches the HTML commands. `type="dlx" pkg="@cloudflare/nimbus-docs" args="list"` now renders `npx @cloudflare/nimbus-docs list` instead of `npx list`.
