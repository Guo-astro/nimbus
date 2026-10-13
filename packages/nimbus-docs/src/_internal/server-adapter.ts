import {
  addCommand,
  detectPackageManager,
  invocation,
  quoteForDisplay,
} from "../cli/pm.js";

export function mcpSdkMessage(root: string): string {
  const { bin, args } = addCommand(detectPackageManager(root), [
    "@modelcontextprotocol/server",
  ]);
  return `nimbus-docs: agents.mcp needs the MCP server SDK in this project. Run \`${bin} ${args.map(quoteForDisplay).join(" ")}\`.`;
}

export type ServerFeature = "MCP" | "request rendering" | "api bundle: false";

/** Shared by the build gate and the build-free config check. */
export function serverAdapterMessage(
  feature: ServerFeature,
  root: string,
  output: string,
  adapter: string,
): string {
  const requirement =
    feature === "MCP"
      ? 'agents.mcp serves /mcp from the site\'s own server, which needs a server adapter and Astro `output: "server"`.'
      : feature === "request rendering"
        ? 'rendering mode "request" requires Astro `output: "server"` and a compatible adapter for production builds.'
        : 'api bundle: false requires Astro `output: "server"` and the Cloudflare or Node adapter.';
  const alternatives =
    feature === "api bundle: false"
      ? "or add adapter-node"
      : "or add adapter-node, adapter-vercel or adapter-netlify";
  return (
    `nimbus-docs: ${requirement} ` +
    `Run \`${invocation("add adapter-cloudflare", root)}\` (${alternatives}). ` +
    `Received output=${output}, adapter=${adapter}.`
  );
}
