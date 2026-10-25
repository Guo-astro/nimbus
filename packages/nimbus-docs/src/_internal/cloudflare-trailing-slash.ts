import fs from "node:fs";
import path from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

/**
 * Cloudflare's default `html_handling` serves `/page.html` at `/page` and
 * redirects `/page/` there. A static site that writes `page.html` files but
 * links `/page/` (`trailingSlash: "always"`) then redirects every link.
 * Returns the warning, or `null` when the site isn't in that state.
 */
export function cloudflareTrailingSlashWarning(
  root: string,
  config: { output: string; trailingSlash: string; format: string | undefined },
): string | null {
  if (config.output !== "static" || config.trailingSlash !== "always" || config.format !== "file") {
    return null;
  }
  const file = ["wrangler.jsonc", "wrangler.json"].find((name) => fs.existsSync(path.join(root, name)));
  if (!file) return null;
  let parsed: { assets?: { html_handling?: unknown } } | undefined;
  try {
    parsed = parseJsonc(fs.readFileSync(path.join(root, file), "utf8")) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed?.assets?.html_handling === "force-trailing-slash") return null;
  return (
    `With trailingSlash: "always" and build.format: "file", Cloudflare redirects every /page/ link to /page (a 307). ` +
    `Set "assets": { "html_handling": "force-trailing-slash" } in ${file}.`
  );
}
