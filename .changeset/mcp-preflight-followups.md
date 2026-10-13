---
"@cloudflare/nimbus-docs": patch
---

`nimbus-docs check` now reports a missing server adapter for `agents.mcp`, request rendering and `api` with `bundle: false`, and a missing MCP SDK, before a build. The MCP server keeps serving requests on a connection after it rejects an oversized body. Preview builds report starter freshness and diffs correctly, `add adapter-*` keeps the adapter's version range, and `agents: { MCP: true }` suggests `mcp`.
