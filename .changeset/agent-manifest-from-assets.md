---
"@cloudflare/nimbus-docs": patch
---

A server build no longer inlines the agent-endpoint manifest in its bundle. Staging writes `_nimbus/agent-endpoint-assets/manifest.json` beside the assets, and the server reads it once per isolate through the same path the twin bodies already use; dev and prerendered routes keep the inlined copy.
