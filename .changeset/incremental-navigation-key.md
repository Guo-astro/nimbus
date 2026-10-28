---
"@cloudflare/nimbus-docs": patch
---

With Astro's experimental incremental build, a page is rebuilt when its sidebar, breadcrumbs or prev/next links change, not only when its own file does. A page whose loader gives no digest is rendered every build. The first build after upgrading renders every page once.
