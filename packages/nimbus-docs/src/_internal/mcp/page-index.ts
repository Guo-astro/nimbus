/**
 * The page index the remote MCP server lists from: one record per page
 * that has a Markdown twin, baked with the agent-endpoint assets and read
 * at request time through the staged-asset reader, so the Worker never
 * carries the content store. Hidden versions are not in it at all.
 */
export const MCP_PAGE_INDEX_VERSION = 1;

export interface McpPageRecord {
  title: string;
  description?: string;
  /** Absolute page URL, as search returns it. */
  url: string;
  /** Absolute URL of the page's Markdown twin. */
  markdownUrl: string;
  /** Site-relative page path without the base, e.g. `/guide/` or `/`. */
  path: string;
  /** Site-relative Markdown path without the base; the Markdown asset's `url`. */
  markdownPath: string;
  collection: string;
  /** The `llms.txt` section this page belongs to (its top-level slug). */
  section: string;
  version?: string;
  deprecated?: true;
  /** `noindex` is not set: the page is on `llms.txt`. */
  discoverable: boolean;
  /** Site search's rule: `searchable: true`, or neither `searchable: false` nor `noindex`. */
  searchable: boolean;
}

export interface McpPageIndex {
  version: typeof MCP_PAGE_INDEX_VERSION;
  /** The current docs version's label, when the site is versioned. */
  currentVersion?: string;
  /** Every listable version label, current first; hidden ones are absent. */
  versions: string[];
  pages: McpPageRecord[];
}
