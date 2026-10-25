import { options } from "virtual:nimbus/agent-capabilities";
import { MCP_CARD_MEDIA_TYPE, mcpServerCard } from "./identity.js";

export const prerender = false;

const body = `${JSON.stringify(mcpServerCard(options.mcp!), null, 2)}\n`;

export function GET() {
  return new Response(body, {
    headers: {
      "Content-Type": MCP_CARD_MEDIA_TYPE,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
