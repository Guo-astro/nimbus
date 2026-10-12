/**
 * The remote MCP server's identity: its paths, its name and the Server
 * Card. Shared by the live `/mcp` handler, the card route, discovery and
 * the `_headers` rules, so every surface reports the same server.
 */
import { withBase } from "../url.js";

export const MCP_PATH = "/mcp";
export const MCP_CARD_PATH = "/mcp/server-card";
export const MCP_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
/** The pinned Server Card schema (v1, revision 526201bb). */
export const MCP_CARD_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
/** The name a site gets when its hostname can't become a server name. */
export const MCP_FALLBACK_NAME = "local.nimbus/docs";
const MCP_NAME_SUFFIX = "/docs";
const MCP_NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const MCP_NAME_MAX_LENGTH = 200;

/**
 * The absolute `/mcp` URL under `site` and `base`. With `trailingSlash:
 * "always"` the endpoint is `/mcp/`: Astro answers the other form with a
 * 308, which keeps a POST, but clients that don't follow redirects need the
 * form the site serves.
 */
export function mcpUrl(
  site: string,
  base: string,
  trailingSlash: "always" | "never" | "ignore" = "ignore",
): string {
  const pathname = trailingSlash === "always" ? `${MCP_PATH}/` : MCP_PATH;
  return new URL(withBase(pathname, base), site).href;
}

/** The card's absolute URL for an endpoint URL. */
export function mcpCardUrl(endpointUrl: string): string {
  return `${endpointUrl.replace(/\/+$/, "")}/server-card`;
}

/**
 * `docs.example.com` → `com.example.docs/docs`: the site's hostname,
 * ASCII (the URL parser applies IDNA), lowercased, without a trailing dot
 * or port, labels reversed. `localhost`, IP literals and anything the
 * schema's name rule rejects fall back to {@link MCP_FALLBACK_NAME}.
 */
export function mcpServerName(site: string): string {
  let hostname: string;
  try {
    hostname = new URL(site).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return MCP_FALLBACK_NAME;
  }
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("[") ||
    /^\d+(?:\.\d+){3}$/.test(hostname)
  ) {
    return MCP_FALLBACK_NAME;
  }
  const name = `${hostname.split(".").reverse().join(".")}${MCP_NAME_SUFFIX}`;
  return MCP_NAME_PATTERN.test(name) && name.length <= MCP_NAME_MAX_LENGTH
    ? name
    : MCP_FALLBACK_NAME;
}

export interface McpServerIdentity {
  name: string;
  /** The installed `@cloudflare/nimbus-docs` version: the package that serves `/mcp`. */
  version: string;
  title: string;
  /** What the server offers, for the card and the `initialize` instructions. */
  description: string;
  instructions: string;
  endpointUrl: string;
  websiteUrl: string;
}

export function mcpServerIdentity(input: {
  site: string;
  base: string;
  title: string;
  version: string;
  /** The published endpoint (`capabilities.mcpUrl`), which carries the trailing-slash form. */
  endpointUrl?: string;
}): McpServerIdentity {
  const endpointUrl = input.endpointUrl ?? mcpUrl(input.site, input.base);
  const description = truncate(
    `Read the ${input.title} documentation: get_page and list_pages, no search.`,
    100,
  );
  return {
    name: mcpServerName(input.site),
    version: input.version,
    title: input.title,
    description,
    instructions:
      `This server reads the ${input.title} documentation. It has two tools and no search: ` +
      "list_pages lists published pages (title, URL, Markdown URL, description) a page at a time, " +
      "filtered by section or version; get_page returns one page as Markdown by its URL or path. " +
      "Pages are the same ones llms.txt lists; fetch llms.txt or the .md URLs directly when a client has no tool support.",
    endpointUrl,
    websiteUrl: new URL(withBase("/", input.base), input.site).href,
  };
}

/** The Server Card document for `/mcp/server-card`. */
export function mcpServerCard(identity: McpServerIdentity) {
  return {
    $schema: MCP_CARD_SCHEMA,
    name: identity.name,
    version: identity.version,
    title: truncate(identity.title, 100),
    description: identity.description,
    websiteUrl: identity.websiteUrl,
    remotes: [{ type: "streamable-http" as const, url: identity.endpointUrl }],
  };
}

function truncate(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, max - 1).join("")}…`;
}
