---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- On server output, a request-rendered page returns its Markdown when the request prefers `text/markdown`; the URL stays canonical and both forms send `Vary: Accept`.
- The starter homepage renders on request when a collection already does under server output, so it negotiates too. All-build homepages remain prerendered in production.
- Preserve owner static-header rules while adding discovery fields, and support prose request rendering and published Markdown negotiation through Astro adapters and standard HTTP on non-Cloudflare deployments.
- Recreate the isolated browser-agent Pagefind instance after observable search failures and give accurate connection/reload guidance. Pagefind's swallowed index-chunk failures remain a documented upstream limitation.
- Include a release-matched agent-interface guide in the framework package and point generated project instructions to it.
