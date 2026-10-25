import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Client directories by request hostname: `{ dir, base }`, registered by a
 * test before it renders. The bare test adapter writes files at `dir`
 * without the base segments, where the real adapter would nest them, so
 * the stub strips the base from the request path.
 */
export const assetRoots = (globalThis.__nimbusTestAssetRoots ??= new Map());

export const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      const root = assetRoots.get(url.hostname);
      if (!root) return new Response("no asset root registered", { status: 500 });
      const prefix = root.base.replace(/\/$/, "");
      const pathname = prefix && url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : url.pathname;
      try {
        const body = await readFile(path.join(root.dir, ...decodeURIComponent(pathname).split("/").filter(Boolean)));
        return new Response(body, { status: 200 });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  },
};
