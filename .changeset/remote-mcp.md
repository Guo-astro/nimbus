---
"@cloudflare/nimbus-docs": minor
"@cloudflare/create-nimbus-docs": patch
---

- `agents: { mcp: true }` serves a remote MCP server at `/mcp` with `list_pages` and `get_page` over the published Markdown, plus a Server Card at `/mcp/server-card`, a line in `llms.txt` and an entry in the AI catalog.
- The starter shows a "Connect MCP" page action with the server URL and a client config snippet when the server is on.
