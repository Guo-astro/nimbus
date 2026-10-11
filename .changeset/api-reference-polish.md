---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- API pages link to the previous and next page in sidebar order, even when a group is collapsed.
- Error responses start collapsed; a link to one, or to a field inside it, opens it.
- A sidebar link to an API or docs-version mount, such as `/api`, no longer warns.
- Operations that fall back to a coordinate route print one summary line, so other warnings stay visible.
- Samples and the endpoint card keep a server URL's query after the path.
- Response toggles meet 4.5:1 contrast in light mode, field anchors work on touch screens, and "Authorisation" reads "Authorization".
