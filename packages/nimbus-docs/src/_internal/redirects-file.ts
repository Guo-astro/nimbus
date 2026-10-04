/**
 * Parse a `_redirects` file: `from to [status]` per line. A missing status
 * is the platform's default (Cloudflare 302, Netlify 301); a trailing `!` is
 * Netlify's force. Lines with conditions (4+ fields) are skipped, since they
 * depend on the request; lines that can't be read are counted as malformed.
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
    const status = Number(rawStatus.replace(/!$/, ""));
    if (!from || !to || !Number.isInteger(status)) {
      malformed++;
      continue;
    }
    redirects.push({ from, to, status, ...(rawStatus.endsWith("!") ? { force: true } : {}) });
  }
  return { redirects, malformed };
}
