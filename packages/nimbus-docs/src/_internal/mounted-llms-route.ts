/**
 * The injected per-mount `llms.txt` route (`/<mount>/[llms].txt`). Injected
 * by the integration when the rendering policy is set and the project has no
 * route file at the mount, with `prerender` following the collection's
 * rendering mode. The pattern is dynamic so a prebuilt mount with no
 * discoverable pages emits nothing — exactly what the shared section route
 * does for an absent section — while the URL stays `/<mount>/llms.txt`. The
 * section is the path segment before `llms.txt`, so one module serves every
 * mount under any base.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { getLlmsPayload } from "../agent-endpoints.js";

function sectionOf(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const encoded = segments.at(-1) === "llms.txt" ? segments.at(-2) : undefined;
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export const getStaticPaths: GetStaticPaths = async ({ routePattern }) => {
  // "/blog/[llms].txt" → section "blog". Emit the one path only when the
  // section has an index to serve.
  const section = routePattern.split("/").filter(Boolean).at(-2);
  const payload = section
    ? await getLlmsPayload({ scope: "section", surface: "index", section })
    : null;
  return payload ? [{ params: { llms: "llms" } }] : [];
};

export const GET: APIRoute = async (context) => {
  const section = sectionOf(context.url.pathname);
  try {
    const payload = section
      ? await getLlmsPayload(
          { scope: "section", surface: "index", section },
          { request: context.request },
        )
      : null;
    if (!payload) return new Response("Not found", { status: 404 });
    return new Response(payload.body, {
      headers: { "Content-Type": payload.mediaType },
    });
  } catch (error) {
    if (context.isPrerendered) throw error;
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  }
};
