---
"@cloudflare/nimbus-docs": minor
---

- A `resource-action-v2` route convention publishes tag pages at lowercase URLs, such as `/api/tags/user-management`, with the same operation URLs as `resource-action-v1`. Existing conventions, and sites without `routes`, are unchanged.
- The API reference recipe sets `resource-action-v2` on new sites and resolves the route collisions the build reports.
