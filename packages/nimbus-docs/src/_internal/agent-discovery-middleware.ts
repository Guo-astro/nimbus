import type { APIContext, MiddlewareHandler } from "astro";
import { capabilities, options } from "virtual:nimbus/agent-capabilities";
import { agentHomepageLinks } from "./agent-discovery.js";
import { prefersMarkdown } from "./markdown-negotiation.js";
import { toRouteKey, withBase } from "./url.js";

const home = withBase("/", options.base).replace(/\/$/, "");
const isHome = (pathname: string) => pathname.replace(/\/$/, "") === home;

function withHeaders(response: Response, set: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers);
  set(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function varyOnAccept(headers: Headers): void {
  const current = headers.get("Vary");
  if (current === "*" || /(^|,)\s*accept\s*(,|$)/i.test(current ?? "")) return;
  headers.set("Vary", current ? `${current}, Accept` : "Accept");
}

/** The indexed entry behind a page URL, so Markdown is found by identity. */
async function pageEntry(context: APIContext) {
  const prefix = options.base.replace(/\/+$/, "");
  const pathname = context.url.pathname;
  if (prefix && !pathname.startsWith(`${prefix}/`)) return undefined;
  const route = toRouteKey(pathname.slice(prefix.length) || "/");
  const { getIndexedEntries } = await import("../runtime.js");
  return (await getIndexedEntries()).find((item) => toRouteKey(item.url) === route);
}

/**
 * The Markdown alternate is a published file. On Cloudflare it comes from the
 * assets binding; other adapters fetch it from the configured site origin.
 */
async function publishedMarkdown(context: APIContext, pathname: string): Promise<Response | undefined> {
  const path = withBase(pathname, options.base);
  try {
    // Loaded on demand: the binding module exists only where the Worker runs.
    const { fetchAgentEndpointAsset } = await import("virtual:nimbus/agent-endpoint-asset-loader");
    const asset = await fetchAgentEndpointAsset(path, context.request);
    if (asset) return asset.ok ? asset : undefined;
    const origin = import.meta.env.DEV ? context.url.origin : new URL(options.site).origin;
    const url = new URL(path, origin);
    if (url.origin !== origin) return undefined;
    const file = await fetch(url, { method: context.request.method, redirect: "error" });
    return file.ok ? file : undefined;
  } catch {
    return undefined;
  }
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  const response = await next();
  if (!["GET", "HEAD"].includes(context.request.method)) return response;
  // Static builds copy the site's emitted llms.txt after prerendering. In dev
  // and for request-rendered llms.txt routes, reuse the owner's existing route.
  if (
    response.status === 404 &&
    context.url.pathname === withBase("/index.md", options.base) &&
    capabilities.llmsUrl
  ) {
    let summary: Response;
    try {
      summary = await context.rewrite("/llms.txt");
    } catch {
      return response;
    }
    if (summary.status !== 200) return response;
    return withHeaders(summary, (headers) => headers.set("Content-Type", "text/markdown; charset=utf-8"));
  }
  if (response.status !== 200) return response;
  const atHome = isHome(context.url.pathname);
  // Only a request-rendered page on server output negotiates: a static host
  // answers from its files before any middleware runs.
  const live = options.output === "server" && !context.isPrerendered && (response.headers.get("Content-Type")?.includes("text/html") ?? false);
  const entry = live && !atHome ? await pageEntry(context) : undefined;
  const negotiates = live && (atHome ? !!capabilities.homepageMarkdownUrl : !!entry);
  let markdown: Response | undefined;
  if (negotiates && prefersMarkdown(context.request.headers.get("Accept"))) {
    markdown = await publishedMarkdown(context, atHome ? "/index.md" : entry!.markdownUrl);
  }
  if (!negotiates && !atHome) return response;
  // The Markdown form keeps the page's own response headers and swaps the body.
  const headers = new Headers(response.headers);
  if (markdown) {
    for (const name of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) headers.delete(name);
    headers.set("Content-Type", markdown.headers.get("Content-Type") ?? "text/markdown; charset=utf-8");
  }
  if (negotiates) varyOnAccept(headers);
  if (atHome) for (const value of agentHomepageLinks(capabilities, options)) headers.append("Link", value);
  return new Response(markdown ? (context.request.method === "HEAD" ? null : markdown.body) : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
