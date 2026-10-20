---
"@cloudflare/nimbus-docs": minor
---

- Previous and next links never point a page at itself, when the sidebar reaches a page twice: a group landing that is also a child link, a page linked from two groups, or an anchor link after its page.
- An isolated sidebar (`isolate.boundaries`) starts with the group's landing page instead of dropping it, labeled "Overview" under `indexDisplay: "overview-leaf"` unless the page sets its own `sidebar.label`. The landing page gains previous and next links.
- A labeled `{ autogenerate: { collection } }` group starts with the collection's landing page at any depth. A collection served one segment deep, such as `/sdk`, now gets the landing row ("Overview"), previous and next links, and a linked breadcrumb; set `sidebar.group.hideIndex: true` on its `index` page to leave it out.
- On request rendering, `/index`, `/<collection>/index` and `/<version>/index` return 404 instead of a copy of the landing page, as built pages do.
- `nimbus-docs check` stops listing and checking a collection deleted since the last build, and notes once that the last build's collection list is out of date.
- API descriptions keep text the HTML sanitizer doesn't know as a tag, such as `metadata.<key>`, as text instead of dropping it. `<script>` is still removed, and other unknown tags render as inert text.
- Code samples for an `apiKey` in a cookie send it as a cookie, such as curl's `--cookie 'session=<session>'`, instead of as a header.
