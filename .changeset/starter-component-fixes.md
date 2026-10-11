---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

Starter fixes:

- The theme toggle no longer submits a surrounding form, reports its state to screen readers, and still switches when storage is blocked.
- Closing a dialog no longer releases another overlay's scroll lock.
- "Copy page" works in Safari, and a failed command copy shows it failed.
- In search, Enter on the close button closes the dialog, and status messages are announced.
- `<Render>` params can't replace registered components; small fixes to breadcrumbs and the mobile table of contents.
- Banner content is rendered as written, like the rest of the site's content.
