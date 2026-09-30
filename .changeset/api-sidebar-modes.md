---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Add `sidebar` to `api` entries, so large API references stop putting the whole navigation tree in every page. `"full"` (the default) keeps today's behavior. `"on-demand"` includes top-level items plus the current page's branch, and loads a collapsed group's contents when it's first opened, from a small HTML file per group that Nimbus builds under `/nimbus-api/nav/<collection>/` and renders with the site's own `ApiSidebarItem`. `"links"` includes the same items and makes each collapsed group a link to its page.

```ts
api: [{ collection: "api", spec: "./src/api/openapi.yaml", sidebar: "on-demand" }],
```

`boundApiNav()` in `@cloudflare/nimbus-docs/api` applies the same rule to navigation a site builds itself, and `getApiNav(model, coordinate, { sidebar })` returns bounded navigation. `ApiNavItem` gains optional `deferred` and `childrenHref` fields. `@cloudflare/nimbus-docs/client` adds `deferContent()`, `remount()`, and `trackNavState()`, and `@cloudflare/nimbus-docs/runtime` adds `navStateScript`, an inline script that restores a sidebar's open groups, loaded rows, and scroll position before the page paints, without replaying animations.

Group pages now list their subsections (`ApiSectionPage.sections`), in HTML and Markdown, so every page stays reachable without the sidebar. The API overview no longer links an `x-tagGroups` category to itself: it lists the category's member sections instead. Both changes apply in every sidebar mode.

Starter components: support `sidebar: "on-demand"` and `sidebar: "links"` in the API sidebar. `ApiSidebarItem` renders a deferred group as a closed group whose rows load on first open, through a new `ApiSidebarLoader` component that pages without deferred groups never render. `ApiBody` lists a group page's subsections. The API sidebar now keeps the groups a reader opened and its scroll position from page to page, in every mode, and no longer fades or replays group animations during navigation. The mobile drawer moved ahead of the desktop rail in `ApiLayout` so one inline script restores both before the page paints. Existing sites keep working unchanged with the default `sidebar: "full"`; to use `"on-demand"`, update `src/components/ui/api-sidebar/` and `src/components/ui/api-layout/` from the starter.
