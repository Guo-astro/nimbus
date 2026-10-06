import type { AgentApiPublication, AgentCapabilities } from "../types.js";

/** Build-time publication record for the site's existing resources. */
export function createAgentCapabilities(input: {
  apis?: readonly (AgentApiPublication & { hidden?: boolean })[];
  homepageMarkdownUrl?: string;
  homepageDiscoverable?: boolean;
  llmsUrl?: string;
}): AgentCapabilities {
  return {
    ...(input.llmsUrl ? { llmsUrl: input.llmsUrl } : {}),
    apis:
      input.apis
        ?.filter((api) => !api.hidden)
        .map(({ hidden: _hidden, ...api }) => ({ ...api })) ?? [],
    ...(input.homepageMarkdownUrl
      ? {
          homepageMarkdownUrl: input.homepageMarkdownUrl,
          ...(input.homepageDiscoverable === false
            ? { homepageDiscoverable: false }
            : {}),
        }
      : {}),
  };
}
