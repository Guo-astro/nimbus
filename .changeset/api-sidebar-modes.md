---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Add `sidebar` to `api` entries, so large API references stop putting the whole navigation tree in every page. `"full"` (the default) keeps today's behavior. `"on-demand"` includes top-level items plus the current page's branch. A collapsed group opens in place and loads its rows from its own page, where the sidebar lists them open; a group without a page, such as an `x-tagGroups` category, loads them from the API overview. Without JavaScript, a collapsed group's label still links to its page. The mode is read from the `api` entry in the Nimbus config, including for sites that pass their entry to `apiCollection({ … })`.

```ts
api: [{ collection: "api", spec: "./src/api/openapi.yaml", sidebar: "on-demand" }],
```

`ApiNavItem` gains optional `deferred` and `childrenHref` fields. `@cloudflare/nimbus-docs/client` adds `initNavSidebar()`, and `@cloudflare/nimbus-docs/runtime` adds `navStateScript`, an inline script, and `navBuildId`, which a sidebar renders as `data-nb-nav-build`. Together they keep a sidebar's open groups, loaded rows, and scroll position from page to page for the session, restored before the page paints and without replaying animations. Cached rows are tied to the build that rendered the page, so after a deployment readers never see rows from an older one, including on client-side navigation. `apiCollection({ … })` warns when it sets a `sidebar` the config doesn't match.

A tag's `x-displayName` now sets its label in the sidebar, page title, and breadcrumbs, while its `name` still decides its coordinate and route. This lets a spec group hundreds of flat tags under readable parents.

Group pages now list their subsections (`ApiSectionPage.sections`), in HTML and Markdown, so every page stays reachable without the sidebar. The API overview no longer links an `x-tagGroups` category to itself: it lists the category's member sections instead. Both changes apply in every sidebar mode.

Starter components: `ApiSidebarItem` renders a deferred group as a closed group with an empty panel, and `ApiLayout` mounts `initNavSidebar` and the restore script for both the desktop rail and the mobile drawer. The API sidebar now keeps the groups a reader opened and its scroll position from page to page in every mode, and no longer fades or replays group animations during navigation. The mobile drawer moved ahead of the desktop rail in `ApiLayout`, so one inline script restores both before the page paints. `ApiBody` lists a group page's subsections.

Existing sites keep working unchanged with the default `sidebar: "full"`. `"on-demand"` needs the new API components: with older ones, the build fails and names the outdated files. Update them with `nimbus-docs add api-layout`, choosing Overwrite for `api-layout` and `api-sidebar`. `nimbus-docs add` now warns when the registry serves components from a different release than the project's `@cloudflare/nimbus-docs`.
