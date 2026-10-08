---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- Sidebar groups are native `details`/`summary` with one class per row type, a CSS caret, and no animation; a group's landing page lists as an "Overview" child row. Each page renders one sidebar tree, shared by the desktop rail and the mobile drawer, and a large sidebar's page HTML drops by roughly 80%. The state scripts drive the old copied markup too.
