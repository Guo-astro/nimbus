import type { AgentCapabilities } from "../types.js";
import type { AgentDiscoveryOptions } from "./agent-discovery.js";
import type { ViteDevServer } from "vite";
import type { VitePluginLike } from "./virtual-config.js";
import { agentDiscoveryManifest } from "./agent-discovery.js";
export function virtualAgentCapabilitiesPlugin(
  get: () => Promise<{
    capabilities: AgentCapabilities;
    options: AgentDiscoveryOptions;
  }>,
): Omit<VitePluginLike, "load"> & {
  load(source: string): Promise<string | undefined>;
  configureServer(server: Pick<ViteDevServer, "middlewares">): void;
} {
  const id = "virtual:nimbus/agent-capabilities";
  return {
    name: "nimbus-docs:agent-capabilities",
    configureServer(server) {
      // Runs before Vite's base middleware: well-known discovery belongs to
      // the origin, including when the documentation lives under /docs/.
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://nimbus.local")
          .pathname;
        if (
          !["GET", "HEAD"].includes(request.method ?? "") ||
          !["/.well-known/ard.json", "/.well-known/ai-catalog.json"].includes(
            pathname,
          )
        )
          return next();
        void get()
          .then(({ capabilities, options }) => {
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Access-Control-Allow-Origin", "*");
            response.end(
              request.method === "HEAD"
                ? undefined
                : JSON.stringify(
                    agentDiscoveryManifest(capabilities, options),
                    null,
                    2,
                  ) + "\n",
            );
          })
          .catch(next);
      });
    },
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    async load(source) {
      if (source !== `\0${id}`) return undefined;
      const { capabilities, options } = await get();
      return `export const capabilities = ${JSON.stringify(capabilities)};\nexport const options = ${JSON.stringify(options)};\n`;
    },
  };
}
