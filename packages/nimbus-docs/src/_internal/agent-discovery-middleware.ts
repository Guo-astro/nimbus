import type { MiddlewareHandler } from "astro";
import { capabilities, options } from "virtual:nimbus/agent-capabilities";
import { agentHomepageLinks } from "./agent-discovery.js";
import { withBase } from "./url.js";

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
      // SSR cannot rewrite to a prerendered route if the copied asset is absent.
      return response;
    }
    if (summary.status !== 200) return response;
    const headers = new Headers(summary.headers);
    headers.set("Content-Type", "text/markdown; charset=utf-8");
    return new Response(summary.body, { status: summary.status, headers });
  }
  const home = withBase("/", options.base).replace(/\/$/, "");
  if (
    response.status !== 200 ||
    context.url.pathname.replace(/\/$/, "") !== home
  )
    return response;
  const headers = new Headers(response.headers);
  for (const value of agentHomepageLinks(capabilities, options))
    headers.append("Link", value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
