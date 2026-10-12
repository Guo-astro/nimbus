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
  output: "static" | "server";
  homepageMarkdownFallback?: boolean;
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
    const name = api.version
      ? `${api.collection} ${api.version}`
      : api.collection;
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
  files: { pathname: string; type: string }[] = capabilities.apis.flatMap(
    (api) =>
      api.spec
        ? [{ pathname: new URL(api.spec.url).pathname, type: api.spec.type }]
        : [],
  ),
  text: {
    paths?: readonly string[];
    /** The published skills files (index, SKILL.md and archives), origin-root paths. */
    skillPaths?: readonly string[];
    ownerHeaders?: string;
    warn?: (message: string) => void;
  } = {},
): string {
  const home = withBase("/", options.base).replace(/\/$/, "");
  const homePaths = new Set([home || "/", `${home}/`]);
  const owner = ownerHeaderPolicies(text.ownerHeaders ?? "");
  const rules: HeaderRule[] = [];
  // Cloudflare limits each _headers line to 2,000 characters and comma-joins
  // repeated fields. Keep API collections/versions on separate Link lines.
  const links = agentHomepageLinks(capabilities, options).map(
    (value) => ["Link", value] as const,
  );
  for (const path of homePaths) rules.push({ pattern: path, headers: [...links] });
  for (const path of [
    "/.well-known/ard.json",
    "/.well-known/ai-catalog.json",
  ]) {
    rules.push({
      pattern: path,
      headers: [
        ["Content-Type", "application/json"],
        ["Access-Control-Allow-Origin", "*"],
      ],
    });
  }
  const ownerTypes = owner
    .filter((policy) => policy.headers.has("content-type"))
    .map((policy) => policy.pattern);
  const addTextRule = (pattern: string, type: string, members: string[]) => {
    if (!members.length) return;
    const covered = members.filter((pathname) =>
      ownerTypes.some((rule) => headerPatternMatches(rule, pathname)),
    );
    // Matching Content-Type values are comma-joined by static hosts. Keep
    // explicit owner policies, including the original issue's wildcard fix.
    if (covered.length) {
      if (covered.length < members.length)
        text.warn?.(
          `Owner Content-Type rules overlap ${pattern}; set the UTF-8 charset for this family in public/_headers.`,
        );
      return;
    }
    rules.push({ pattern, headers: [["Content-Type", `${type}; charset=utf-8`]], evaluated: true });
  };
  if (capabilities.homepageMarkdownUrl) {
    const pathname = new URL(capabilities.homepageMarkdownUrl).pathname;
    addTextRule(pathname, "text/markdown", [pathname]);
  }
  const paths = text.paths ?? [];
  for (const [pattern, type] of [
    ["/llms.txt", "text/plain"],
    ["/llms-full.txt", "text/plain"],
    ["/robots.txt", "text/plain"],
    ["/*/llms.txt", "text/plain"],
    ["/*/llms-full.txt", "text/plain"],
    ["/*/index.md", "text/markdown"],
  ] as const) {
    // A fixed number of narrow families avoids Cloudflare's 100-rule limit
    // without changing unrelated .txt or .md downloads.
    const members = paths
      .filter((pathname) => headerPatternMatches(pattern, pathname))
      .map(
        (pathname) =>
          new URL(
            withBase(
              pathname.split("/").map(encodeURIComponent).join("/"),
              options.base,
            ),
            options.site,
          ).pathname,
      );
    addTextRule(
      new URL(withBase(pattern, options.base), options.site).pathname,
      type,
      members,
    );
  }
  if (capabilities.apis.length) {
    // Extensionless, so no host can infer its type; HEAD carries the Link too.
    rules.push({
      pattern: API_CATALOG_PATH,
      headers: [
        ["Content-Type", API_CATALOG_MEDIA_TYPE],
        ["Access-Control-Allow-Origin", "*"],
        ["Link", apiCatalogLink(options.site)],
      ],
    });
  }
  for (const file of files)
    rules.push({
      pattern: file.pathname,
      headers: [
        ["Content-Type", file.type],
        ["Access-Control-Allow-Origin", "*"],
      ],
    });
  if (capabilities.skillsIndexUrl) {
    // Static hosts infer SKILL.md and .tar.gz types from the extension; the
    // RFC wants CORS on everything and application/json on the index. The
    // wildcards are checked against the files they cover, like the text
    // families, so an owner `/*.json` rule counts and a `/*.woff2` one doesn't.
    const index = new URL(capabilities.skillsIndexUrl).pathname;
    const skillPaths = [...new Set([index, ...(text.skillPaths ?? [])])];
    for (const [pattern, name, value] of [
      ["/.well-known/agent-skills/*", "Access-Control-Allow-Origin", "*"],
      ["/.well-known/agent-skills/index.json", "Content-Type", "application/json"],
      ["/.well-known/agent-skills/*.tar.gz", "Content-Type", "application/gzip"],
    ] as const) {
      const members = skillPaths.filter((pathname) => headerPatternMatches(pattern, pathname));
      if (!ownerSetsHeaderOnMembers(owner, pattern, name, members, text.warn)) {
        rules.push({ pattern, headers: [[name, value]], evaluated: true });
      }
    }
  }
  const kept = rules.flatMap((rule) => {
    const headers = rule.evaluated
      ? rule.headers
      : rule.headers.filter(([name]) => !ownerSetsHeader(owner, rule.pattern, name, text.warn));
    return headers.length ? [{ pattern: rule.pattern, headers }] : [];
  });
  return `# Nimbus agent discovery (generated)\n${kept
    .map(
      (rule) =>
        `${rule.pattern}\n${rule.headers.map(([name, value]) => `  ${name}: ${value}`).join("\n")}`,
    )
    .join("\n\n")}\n# End Nimbus agent discovery\n`;
}

interface HeaderRule {
  pattern: string;
  headers: Array<readonly [name: string, value: string]>;
  /** Already checked against the owner rules by the concrete paths it covers. */
  evaluated?: boolean;
}

/** One owner rule: its path pattern and the header names it sets or removes. */
interface OwnerHeaderPolicy {
  pattern: string;
  headers: Set<string>;
}

/**
 * Headers that may legitimately repeat: static hosts join matching values
 * with a comma, which is valid for these and wrong for every other header.
 */
const MULTI_VALUED_HEADERS = new Set(["link"]);

/**
 * Whether an owner rule already sets (or removes with `!`) a header on a
 * path the generated rule covers. Hosts apply every matching rule and
 * comma-join a repeated header, so a generated value would corrupt the
 * owner's, as `Access-Control-Allow-Origin: *, *` does. An owner rule
 * narrower than the generated pattern wins too, with a warning, since a
 * generated wildcard can't exclude one path.
 */
function ownerSetsHeader(
  owner: readonly OwnerHeaderPolicy[],
  pattern: string,
  name: string,
  warn?: (message: string) => void,
): boolean {
  const header = name.toLowerCase();
  if (MULTI_VALUED_HEADERS.has(header)) return false;
  let covered = false;
  for (const policy of owner) {
    if (!policy.headers.has(header)) continue;
    if (headerPatternMatches(policy.pattern, representativePath(pattern))) {
      covered = true;
    } else if (headerPatternMatches(pattern, representativePath(policy.pattern))) {
      covered = true;
      warn?.(
        `Owner ${name} rule ${policy.pattern} overlaps ${pattern}; in public/_headers, replace it with one rule covering ${pattern}, or add exact rules for the other files under ${pattern}.`,
      );
    }
  }
  return covered;
}

/**
 * Whether an owner rule already sets a header on any of the concrete paths a
 * generated rule covers. All covered: the owner has it. Some covered: a
 * generated wildcard can't exclude those paths, so the owner wins for the
 * family, with a warning saying how to cover the rest.
 */
function ownerSetsHeaderOnMembers(
  owner: readonly OwnerHeaderPolicy[],
  pattern: string,
  name: string,
  members: readonly string[],
  warn?: (message: string) => void,
): boolean {
  const header = name.toLowerCase();
  if (MULTI_VALUED_HEADERS.has(header) || members.length === 0) return false;
  const covering = owner.filter(
    (policy) =>
      policy.headers.has(header) &&
      members.some((pathname) => headerPatternMatches(policy.pattern, pathname)),
  );
  if (covering.length === 0) return false;
  const covered = members.filter((pathname) =>
    covering.some((policy) => headerPatternMatches(policy.pattern, pathname)),
  );
  if (covered.length < members.length) {
    warn?.(
      `Owner ${name} rule ${covering.map((policy) => policy.pattern).join(", ")} overlaps ${pattern}; in public/_headers, replace it with one rule covering ${pattern}, or add exact rules for the other files under ${pattern}.`,
    );
  }
  return true;
}

/** A concrete path a pattern matches, for testing one pattern against another. */
function representativePath(pattern: string): string {
  return (normalizeHeaderPattern(pattern) ?? pattern).replace(/\*|:[A-Za-z]\w*/g, "x");
}

export function appendAgentDiscoveryHeaders(
  ownerHeaders: string,
  generated: string,
): string {
  let owner = withoutGeneratedHeaders(ownerHeaders);
  const rules = new Map(
    generated
      .replace(/^#.*\r?\n?/gm, "")
      .trim()
      .split(/\r?\n\r?\n/)
      .filter(Boolean)
      .map((rule) => {
        const [path, ...headers] = rule.split(/\r?\n/);
        return [path!, headers.join("\n")] as const;
      }),
  );
  // A path line is read by its shape after trimming, as hosts read it.
  const paths = [...owner.matchAll(/^[ \t\uFEFF]*(\S[^\r\n]*)/gm)].filter((match) =>
    HEADER_PATH_LINE.test(match[1]!.trim()),
  );
  for (let index = paths.length - 1; index >= 0; index--) {
    const match = paths[index]!;
    const headers = rules.get(match[1]!.trim());
    if (!headers) continue;
    const end = paths[index + 1]?.index ?? owner.length;
    const offset = match.index + owner.slice(match.index, end).trimEnd().length;
    const newline = owner.includes("\r\n") ? "\r\n" : "\n";
    const block = [
      "",
      "# Nimbus agent discovery headers (generated)",
      headers.replace(/\n/g, newline),
      "# End Nimbus agent discovery headers",
    ].join(newline);
    owner = owner.slice(0, offset) + block + owner.slice(offset);
    rules.delete(match[1]!.trim());
  }
  if (!rules.size) return owner;
  const remaining = `# Nimbus agent discovery (generated)\n${[...rules].map(([path, headers]) => `${path}\n${headers}`).join("\n\n")}\n# End Nimbus agent discovery\n`;
  const separator =
    !owner || owner.endsWith("\n\n")
      ? ""
      : owner.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${owner}${separator}${remaining}`;
}

function withoutGeneratedHeaders(headers: string): string {
  return headers
    .replace(
      /\r?\n# Nimbus agent discovery headers \(generated\)\r?\n[\s\S]*?# End Nimbus agent discovery headers/g,
      "",
    )
    .replace(
      /^# Nimbus agent discovery \(generated\)\r?\n[\s\S]*?# End Nimbus agent discovery\r?\n?/gm,
      "",
    );
}

/** Hosts trim each line and read a path by its shape, not its indentation. */
const HEADER_PATH_LINE = /^([^\s]+:\/\/|\/)/;

function ownerHeaderPolicies(headers: string): OwnerHeaderPolicy[] {
  const policies: OwnerHeaderPolicy[] = [];
  let current: OwnerHeaderPolicy | undefined;
  for (const raw of withoutGeneratedHeaders(headers).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (HEADER_PATH_LINE.test(line)) {
      current = { pattern: line, headers: new Set() };
      policies.push(current);
      continue;
    }
    // `Name: value` sets a header; `! Name` (the host's unset operator, with
    // the space) removes one. Both are the owner's policy for that header on
    // the rule's paths.
    const header = /^! ([^:\s]+)$/.exec(line)?.[1] ?? /^([^:\s]+)\s*:/.exec(line)?.[1];
    if (header && current) current.headers.add(header.toLowerCase());
  }
  return policies;
}

/**
 * A pattern's path, as the host compares it: a host-qualified owner rule
 * reduced to its path, and raw Unicode or spaces URL-normalized.
 */
function normalizeHeaderPattern(pattern: string): string | undefined {
  // Path-only generated rules apply on preview hosts too. Conservatively
  // honor an absolute owner policy even when its hostname differs from site.
  if (/^[^\s]+:\/\//.test(pattern)) {
    const pathStart = pattern.indexOf("/", pattern.indexOf("://") + 3);
    pattern = pathStart === -1 ? "/" : pattern.slice(pathStart);
  }
  try {
    // Static hosts URL-normalize raw Unicode and spaces in owner paths.
    return new URL(`//${pattern}`, "relative://").pathname;
  } catch {
    return undefined;
  }
}

function headerPatternMatches(pattern: string, pathname: string): boolean {
  const normalized = normalizeHeaderPattern(pattern);
  if (normalized === undefined) return false;
  pattern = normalized;
  let source = "";
  let offset = 0;
  for (const token of pattern.matchAll(/\*|:[A-Za-z]\w*/g)) {
    source += pattern
      .slice(offset, token.index)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    source += token[0] === "*" ? ".*" : "[^/]+";
    offset = token.index + token[0].length;
  }
  source += pattern.slice(offset).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${source}$`).test(pathname);
}
