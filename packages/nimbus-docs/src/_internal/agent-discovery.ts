import type { AgentCapabilities } from "../types.js";
import { safeDecode, withBase } from "./url.js";
import {
  API_CATALOG_MEDIA_TYPE,
  API_CATALOG_PATH,
  apiCatalogLink,
  apiCatalogUrl,
} from "./agent-api-catalog.js";

export interface AgentDiscoveryOptions {
  site: string;
  title: string;
  base: string;
}
export interface ArdEntry {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  representativeQueries: [string, string];
}

/** ARD v0.91 entries in the compatible AI Catalog 1.0 transport envelope. */
export function agentDiscoveryManifest(
  capabilities: AgentCapabilities,
  options: AgentDiscoveryOptions,
) {
  const site = new URL(options.site);
  const publisher =
    site.hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/[^a-z0-9.-]/g, "-") || "localhost";
  const homeUrl = new URL(site.origin + withBase("/", options.base));
  // Escape each path segment once. Reserve '-' for segment boundaries and '_'
  // for escaped bytes so /a/b, /a-b and /a_2Db remain distinct stable handles.
  const token = (segment: string) =>
    encodeURIComponent(safeDecode(segment))
      .replace(
        /[-_!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      )
      .replace(/%/g, "_");
  const mount = homeUrl.pathname.replace(/\/$/, "");
  const namespace = `docs${mount ? `-${mount.slice(1).split("/").map(token).join("-")}` : ""}`;
  const entries: ArdEntry[] = [];
  function add(
    key: string,
    displayName: string,
    type: string,
    url: string,
    queries: [string, string],
  ) {
    entries.push({
      identifier: `urn:air:${publisher}:${namespace}:${key}`,
      displayName,
      type,
      url,
      representativeQueries: queries,
    });
  }
  if (capabilities.llmsUrl)
    add(
      "index",
      `${options.title} documentation index`,
      "text/plain",
      capabilities.llmsUrl,
      [
        `Find the ${options.title} documentation`,
        `List topics covered by ${options.title}`,
      ],
    );
  if (
    capabilities.homepageMarkdownUrl &&
    capabilities.homepageDiscoverable !== false
  )
    add(
      "home",
      `${options.title} overview`,
      "text/markdown",
      capabilities.homepageMarkdownUrl,
      [
        `Get started with ${options.title}`,
        `Read an overview of ${options.title}`,
      ],
    );
  for (const api of capabilities.apis) {
    if (!api.spec) continue;
    const name = api.version ? `${api.collection} ${api.version}` : api.collection;
    add(
      `api-${token(api.collection)}${api.version ? `-${token(api.version)}` : ""}`,
      `${options.title} ${name} API specification`,
      api.spec.type,
      api.spec.url,
      [
        `Call the ${options.title} ${name} API`,
        `List the operations of the ${options.title} ${name} API`,
      ],
    );
  }
  if (capabilities.skillsIndexUrl)
    add(
      "skills",
      `${options.title} agent skills`,
      "application/json",
      capabilities.skillsIndexUrl,
      [
        `Find agent skills published by ${options.title}`,
        `Install a skill for working with ${options.title}`,
      ],
    );
  return {
    specVersion: "1.0",
    host: {
      displayName: options.title,
      identifier: homeUrl.href,
      documentationUrl: homeUrl.href,
    },
    entries,
  };
}

function link(url: string, rel: string, type?: string): string {
  // URL serialisation encodes delimiters supplied by content paths.
  const target = new URL(url).href;
  if (type && !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type))
    throw new Error(`Invalid discovery media type: ${type}`);
  return `<${target}>; rel="${rel}"${type ? `; type="${type}"` : ""}`;
}

/** One source for the static _headers file and request-rendered homepages. */
export function agentHomepageLinks(
  capabilities: AgentCapabilities,
  options: AgentDiscoveryOptions,
): string[] {
  const links = [
    link(new URL("/.well-known/ard.json", options.site).href, "ard"),
  ];
  if (capabilities.llmsUrl)
    links.push(link(capabilities.llmsUrl, "describedby", "text/plain"));
  if (
    capabilities.homepageMarkdownUrl &&
    capabilities.homepageDiscoverable !== false
  )
    links.push(
      link(capabilities.homepageMarkdownUrl, "alternate", "text/markdown"),
    );
  if (capabilities.apis.length)
    links.push(link(apiCatalogUrl(options.site), "api-catalog"));
  for (const api of capabilities.apis)
    links.push(link(api.docsUrl, "service-doc", "text/html"));
  for (const api of capabilities.apis)
    if (api.spec) links.push(link(api.spec.url, "service-desc", api.spec.type));
  return links;
}

export function agentDiscoveryHeaderRules(
  capabilities: AgentCapabilities,
  options: AgentDiscoveryOptions,
  /** Published files needing a media type, hidden versions' included. */
  files: { pathname: string; type: string }[] = capabilities.apis.flatMap((api) =>
    api.spec ? [{ pathname: new URL(api.spec.url).pathname, type: api.spec.type }] : [],
  ),
): string {
  const home = withBase("/", options.base).replace(/\/$/, "");
  const homePaths = new Set([home || "/", `${home}/`]);
  // Cloudflare limits each _headers line to 2,000 characters and comma-joins
  // repeated fields. Keep API collections/versions on separate Link lines.
  const links = agentHomepageLinks(capabilities, options)
    .map((value) => `  Link: ${value}`)
    .join("\n");
  const rules = [...homePaths].map((path) => `${path}\n${links}`);
  for (const path of [
    "/.well-known/ard.json",
    "/.well-known/ai-catalog.json",
  ]) {
    rules.push(
      `${path}\n  Content-Type: application/json\n  Access-Control-Allow-Origin: *`,
    );
  }
  if (capabilities.homepageMarkdownUrl)
    rules.push(
      `${new URL(capabilities.homepageMarkdownUrl).pathname}\n  Content-Type: text/markdown; charset=utf-8`,
    );
  if (capabilities.apis.length) {
    // Extensionless, so no host can infer its type; HEAD carries the Link too.
    rules.push(
      `${API_CATALOG_PATH}\n  Content-Type: ${API_CATALOG_MEDIA_TYPE}\n  Access-Control-Allow-Origin: *\n  Link: ${apiCatalogLink(options.site)}`,
    );
  }
  for (const file of files)
    rules.push(`${file.pathname}\n  Content-Type: ${file.type}\n  Access-Control-Allow-Origin: *`);
  if (capabilities.skillsIndexUrl) {
    // Static hosts infer SKILL.md and .tar.gz types from the extension; the
    // RFC wants CORS on everything and application/json on the index.
    rules.push(
      "/.well-known/agent-skills/*\n  Access-Control-Allow-Origin: *",
      "/.well-known/agent-skills/index.json\n  Content-Type: application/json",
      "/.well-known/agent-skills/*.tar.gz\n  Content-Type: application/gzip",
    );
  }
  return `# Nimbus agent discovery (generated)\n${rules.join("\n\n")}\n# End Nimbus agent discovery\n`;
}

export function appendAgentDiscoveryHeaders(
  ownerHeaders: string,
  generated: string,
): string {
  const owner = ownerHeaders.replace(
    /# Nimbus agent discovery \(generated\)\n[\s\S]*?# End Nimbus agent discovery\n?/g,
    "",
  );
  const separator =
    !owner || owner.endsWith("\n\n")
      ? ""
      : owner.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${owner}${separator}${generated}`;
}
