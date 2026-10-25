/**
 * Parse a `_redirects` file: `from to [status]` per line. Lines with
 * conditions (4+ fields) are skipped, since they depend on the request.
 */

import type { NormalizedRedirect } from "./redirect-emitters.js";

export interface ParsedRedirectsFile {
  redirects: NormalizedRedirect[];
  malformed: number;
}

export function parseRedirectsFile(
  contents: string,
  defaultStatus: number,
): ParsedRedirectsFile {
  const redirects: NormalizedRedirect[] = [];
  let malformed = 0;
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length > 3) continue;
    const [from, to, rawStatus = String(defaultStatus)] = fields;
    const force = rawStatus.endsWith("!");
    const status = Number(force ? rawStatus.slice(0, -1) : rawStatus);
    if (!from || !to || !Number.isInteger(status)) {
      malformed++;
      continue;
    }
    redirects.push(force ? { from, to, status, force } : { from, to, status });
  }
  return { redirects, malformed };
}
