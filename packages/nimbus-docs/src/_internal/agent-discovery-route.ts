import { capabilities, options } from "virtual:nimbus/agent-capabilities";
import { agentDiscoveryManifest } from "./agent-discovery.js";
export const prerender = true;
export function GET() {
  return new Response(
    JSON.stringify(agentDiscoveryManifest(capabilities, options), null, 2) +
      "\n",
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
