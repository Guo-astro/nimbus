---
"@cloudflare/nimbus-docs": patch
---

- `astro dev` renders a page's headings when the page is first requested, not every page at content sync. Startup and each file save no longer scale with the number of docs.
- Builds are unchanged.
