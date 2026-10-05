import { fromHtml } from "hast-util-from-html";

import {
  SEARCH_LIMITS,
  PagefindCompatibilityError,
  searchFailure as failure,
} from "./agent-search-contract.js";
import type {
  DocumentationSearchResponse,
  DocumentationSearchOptions,
  DocumentationPagefind,
  DocumentationSection,
} from "./agent-search-contract.js";

function plainText(html: string): string {
  const root = fromHtml(html, { fragment: true });
  function visit(node: typeof root | (typeof root.children)[number]): string {
    if (node.type === "text") return node.value;
    if ("children" in node) return node.children.map(visit).join("");
    return "";
  }
  return visit(root);
}

/** Pagefind URLs may already include Astro's base. Never add it twice. */
function sectionUrl(
  value: string,
  options: DocumentationSearchOptions,
): string {
  const site = new URL(options.site);
  const base = `/${(options.base ?? "/").split("/").filter(Boolean).join("/")}`;
  const url = new URL(
    value,
    `${site.origin}${base === "/" ? "/" : `${base}/`}`,
  );
  if (
    url.origin !== site.origin ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    throw new Error("Pagefind returned an off-site URL");
  }
  if (
    base !== "/" &&
    url.pathname !== base &&
    !url.pathname.startsWith(`${base}/`)
  ) {
    url.pathname = base + url.pathname;
  }
  // A page-level match points to the document top; don't invent a heading slug.
  return url.href.includes("#") ? url.href : `${url.href}#`;
}

/** Load the existing build's Pagefind index; this function never builds an index. */
export function createDocumentationSearch(
  loadIndex: () => Promise<DocumentationPagefind>,
  options: DocumentationSearchOptions,
): (input: unknown) => Promise<DocumentationSearchResponse> {
  const run = async (input: unknown): Promise<DocumentationSearchResponse> => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return failure("invalid_input");
    const record = input as Record<string, unknown>;
    const { query, limit = SEARCH_LIMITS.defaultLimit, version } = record;
    if (
      Object.keys(record).some(
        (key) => !["query", "limit", "version"].includes(key),
      ) ||
      typeof query !== "string" ||
      query.length > SEARCH_LIMITS.query * 2 ||
      !query.trim() ||
      [...query].length > SEARCH_LIMITS.query ||
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > SEARCH_LIMITS.maxLimit ||
      (version !== undefined &&
        (typeof version !== "string" || !options.versions?.includes(version)))
    ) {
      return failure("invalid_input");
    }
    let index: DocumentationPagefind;
    try {
      index = await loadIndex();
    } catch (error) {
      return failure(
        "index_unavailable",
        error instanceof PagefindCompatibilityError ? error.message : undefined,
      );
    }
    try {
      const filters: Record<string, string | { none: string[] }> =
        version === undefined
          ? { status: { none: ["deprecated"] } }
          : { version: version as string };
      const found = await index.search(query.trim(), { filters });
      const results: DocumentationSection[] = [];
      const seen = new Set<string>();
      // Load lazily and stop as soon as the section limit is met.
      for (const match of found.results.slice(0, SEARCH_LIMITS.maxLimit * 4)) {
        const page = await match.data();
        const title = page.meta.title ?? "";
        const sections = page.sub_results?.length
          ? page.sub_results
          : [{ title, url: page.url, excerpt: page.excerpt }];
        for (const section of sections) {
          const url = sectionUrl(section.url, options);
          if (seen.has(url)) continue;
          seen.add(url);
          results.push({
            title,
            heading: section.title,
            url,
            excerpt: [...plainText(section.excerpt)]
              .slice(0, SEARCH_LIMITS.excerpt)
              .join(""),
          });
          if (results.length === limit) return { results };
        }
      }
      return { results };
    } catch {
      return failure("search_failed");
    }
  };
  // Pagefind mutates cached fragments while constructing query-specific excerpts.
  // Keep search + data hydration atomic relative to other calls on this instance.
  let pending: Promise<unknown> = Promise.resolve();
  return (input) => {
    const response = pending.then(() => run(input));
    pending = response.catch(() => undefined);
    return response;
  };
}
