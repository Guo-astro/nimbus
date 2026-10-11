/**
 * The injected per-mount `llms.txt` route. Injected by the integration when
 * the rendering policy is set and the project has no route file at the
 * mount, with `prerender` following the collection's rendering mode. Its
 * shape follows the project's section route:
 *
 * - `/<mount>/[llms].txt` beside `[section]/llms.txt.ts`: the mount's one
 *   index. The pattern is dynamic so a prebuilt mount with no discoverable
 *   pages emits nothing, while the URL stays `/<mount>/llms.txt`.
 * - `/<mount>/[...section]/llms.txt` beside `[...section]/llms.txt.ts`: the
 *   mount's index (empty rest) and every nested section under it.
 *
 * The mount comes from the route pattern, so one module serves every mount
 * under any base.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { getLlmsPayload, getLlmsStaticPaths } from "../agent-endpoints.js";

/** The mount's section path: "/blog/[...section]/llms.txt" → "blog". */
function mountOf(routePattern: string): string | undefined {
  const segments = routePattern.split("/").filter(Boolean);
  return segments.at(-1) === "[llms].txt"
    ? segments.slice(0, -1).join("/")
    : segments.at(-1) === "llms.txt" && segments.at(-2)?.startsWith("[...")
      ? segments.slice(0, -2).join("/")
      : undefined;
}

function sectionOf(mount: string, rest: string | undefined): string {
  return rest ? `${mount}/${rest}` : mount;
}

export const getStaticPaths: GetStaticPaths = async ({ routePattern }) => {
  const mount = mountOf(routePattern);
  if (!mount) return [];
  if (routePattern.endsWith("/[llms].txt")) {
    // Emit the one path only when the section has an index to serve.
    const payload = await getLlmsPayload({ scope: "section", surface: "index", section: mount });
    return payload ? [{ params: { llms: "llms" } }] : [];
  }
  return (await getLlmsStaticPaths())
    .filter(({ params }) => params.section === mount || params.section.startsWith(`${mount}/`))
    .map(({ params, props }) => ({
      params: { section: params.section === mount ? undefined : params.section.slice(mount.length + 1) },
      props,
    }));
};

export const GET: APIRoute = async (context) => {
  const mount = mountOf(context.routePattern);
  try {
    const payload = mount
      ? await getLlmsPayload(
          {
            scope: "section",
            surface: "index",
            section: context.routePattern.endsWith("/[llms].txt")
              ? mount
              : sectionOf(mount, context.params.section),
          },
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
