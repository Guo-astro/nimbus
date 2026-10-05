/**
 * RFC 9727 API catalog: an RFC 9264 linkset at /.well-known/api-catalog with
 * one link context per visible API version. Reads the capability record only,
 * so it knows nothing about any spec format.
 */
import type { AgentCapabilities } from "../types.js";

export const API_CATALOG_PATH = "/.well-known/api-catalog";
export const API_CATALOG_PROFILE = "https://www.rfc-editor.org/info/rfc9727";
export const API_CATALOG_MEDIA_TYPE = `application/linkset+json; profile="${API_CATALOG_PROFILE}"`;

interface LinkTarget {
  href: string;
  type?: string;
}
export interface ApiCatalogContext {
  anchor: string;
  "service-desc"?: LinkTarget[];
  "service-doc": LinkTarget[];
}

export function apiCatalogUrl(site: string): string {
  return new URL(API_CATALOG_PATH, site).href;
}

/** `Link` value every catalog response carries (RFC 9727 §2). */
export function apiCatalogLink(site: string): string {
  return `<${apiCatalogUrl(site)}>; rel="api-catalog"`;
}

/** The catalog document, or `undefined` for a site with no API collections. */
export function apiCatalog(
  capabilities: AgentCapabilities,
): { linkset: ApiCatalogContext[] } | undefined {
  if (capabilities.apis.length === 0) return undefined;
  return {
    linkset: capabilities.apis.map((api) => ({
      anchor: api.docsUrl,
      ...(api.spec
        ? { "service-desc": [{ href: api.spec.url, type: api.spec.type }] }
        : {}),
      "service-doc": [
        { href: api.docsUrl, type: "text/html" },
        { href: api.markdownUrl, type: "text/markdown" },
      ],
    })),
  };
}
