import { capabilities, options } from "virtual:nimbus/agent-capabilities";
import { MCP_CARD_MEDIA_TYPE, mcpServerCard, mcpServerIdentity } from "./identity.js";

export const prerender = true;

export function GET() {
  if (!capabilities.mcpUrl) return new Response(null, { status: 404 });
  const card = mcpServerCard(
    mcpServerIdentity({
      site: options.site,
      base: options.base,
      title: options.title,
      version: options.nimbusVersion ?? "0.0.0",
    }),
  );
  return new Response(JSON.stringify(card, null, 2) + "\n", {
    headers: {
      "Content-Type": MCP_CARD_MEDIA_TYPE,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Expose-Headers": "ETag",
    },
  });
}
