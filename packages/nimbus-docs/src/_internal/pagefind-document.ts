import GithubSlugger from "github-slugger";
import { markdownToHast } from "satteri";

import type { RequestRouteInventoryEntry } from "./request-route-url.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripInlineHtml(value: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start === -1) return output + value.slice(cursor);
    let end = start + 1;
    let quote: '"' | "'" | undefined;
    for (; end < value.length; end++) {
      const character = value[end];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end === value.length) return output + value.slice(cursor);
    output += value.slice(cursor, start);
    cursor = end + 1;
  }
  return output;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

const UNINDEXED = /^(?:script|style)$/i;

/**
 * A request-rendered page's Markdown as HTML for Pagefind, so excerpts read as
 * text rather than Markdown syntax, parsed once so reference links resolve
 * across headings. Headings get the page's anchor ids for sub-results.
 * Elements keep no attributes, and raw HTML keeps only its text, so nothing
 * the author wrote can open a tag that swallows the rest.
 */
export function pagefindMarkdown(markdown: string): string {
  const slugger = new GithubSlugger();
  const text = (node: HastNode): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.type === "raw"
        ? stripInlineHtml(node.value ?? "")
        : (node.children ?? []).map(text).join("");
  const children = (nodes: HastNode[]): string => {
    let out = "";
    // Inline raw HTML arrives as separate tag nodes: skip from an opening
    // script or style tag to its closing one.
    let skipping = false;
    for (const node of nodes) {
      const raw = node.type === "raw" ? (node.value ?? "") : "";
      if (skipping) {
        if (/<\/(?:script|style)\s*>/i.test(raw)) skipping = false;
        continue;
      }
      if (/^\s*<(?:script|style)\b/i.test(raw)) {
        skipping = !/<\/(?:script|style)\s*>/i.test(raw);
        continue;
      }
      out += render(node);
    }
    return out;
  };
  const render = (node: HastNode): string => {
    if (node.type === "text") return escapeHtml(node.value ?? "");
    if (node.type === "raw") return escapeHtml(stripInlineHtml(node.value ?? ""));
    if (node.type !== "element" || !node.tagName) return children(node.children ?? []);
    if (UNINDEXED.test(node.tagName)) return "";
    if (/^h[1-6]$/.test(node.tagName)) {
      const heading = text(node).replace(/[<>]/g, "").trim();
      return `<${node.tagName} id="${escapeHtml(slugger.slug(heading))}">${escapeHtml(heading)}</${node.tagName}>`;
    }
    return `<${node.tagName}>${children(node.children ?? [])}</${node.tagName}>`;
  };
  try {
    return render(markdownToHast(markdown) as HastNode).trim();
  } catch {
    return `<pre>${escapeHtml(markdown)}</pre>`;
  }
}

export function pagefindDocument(entry: RequestRouteInventoryEntry): string {
  const versionFilter = entry.version
    ? ` data-pagefind-filter="version:${escapeHtml(entry.version)}"`
    : "";
  return [
    `<!doctype html><html lang="${escapeHtml(entry.language)}"><head>`,
    `<title>${escapeHtml(entry.title)}</title>`,
    `</head><body><main data-pagefind-body${versionFilter}>`,
    entry.deprecated
      ? '<span hidden data-pagefind-filter="status:deprecated"></span>'
      : "",
    `<h1>${escapeHtml(entry.title)}</h1>`,
    entry.description ? `<p>${escapeHtml(entry.description)}</p>` : "",
    pagefindMarkdown(entry.content ?? ""),
    `</main></body></html>`,
  ].join("");
}
