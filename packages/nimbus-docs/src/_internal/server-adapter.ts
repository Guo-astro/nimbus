import { addCommand, detectPackageManager, invocation, quoteForDisplay } from "../cli/pm.js";

export function mcpSdkMessage(root: string): string {
  const { bin, args } = addCommand(detectPackageManager(root), ["@modelcontextprotocol/server"]);
  return `nimbus-docs: agents.mcp needs the MCP server SDK in this project. Run \`${bin} ${args.map(quoteForDisplay).join(" ")}\`.`;
}

export type ServerFeature = "MCP" | "request rendering" | "api bundle: false";

/** The feature an adapter error names: the strictest one, so its advice covers the others. */
export function serverAdapterFeature(features: {
  unbundledApi: boolean;
  requestRendering: boolean;
  mcp: boolean;
}): ServerFeature | undefined {
  if (features.unbundledApi) return "api bundle: false";
  if (features.requestRendering) return "request rendering";
  if (features.mcp) return "MCP";
  return undefined;
}

/** Shared by the build gate and `check`. */
export function serverAdapterMessage(feature: ServerFeature, root: string): string {
  const add = `Run \`${invocation("add adapter-cloudflare", root)}\``;
  switch (feature) {
    case "MCP":
      return `nimbus-docs: agents.mcp serves /mcp from the site's own server, which needs a server adapter. ${add} (or add adapter-node, adapter-vercel or adapter-netlify), or set agents.mcp to false.`;
    case "request rendering":
      return `nimbus-docs: rendering mode "request" needs a server adapter for production builds. ${add} (or add adapter-node, adapter-vercel or adapter-netlify).`;
    case "api bundle: false":
      return `nimbus-docs: api bundle: false needs the Cloudflare or Node adapter. ${add} (or add adapter-node).`;
  }
}
