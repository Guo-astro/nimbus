/**
 * nimbus/redirected-link — links that work only through a permanent
 * redirect, with the URL to write instead: the last permanent hop's
 * destination, without `base`, or an absolute URL on `site` when it's
 * outside `base`. Off by default.
 *
 * Resolves with `internal-link`'s `ignore` so both rules agree; broken
 * chains are `internal-link`'s to report. Chains that start with a temporary
 * redirect are intentional and skipped. Options: `ignore`, `components`.
 */

import { matchesAnyIgnore } from "../../_internal/ignore-glob.js";
import { linkRouteKey } from "../../_internal/route-key.js";
import { inferProjectRoot, loadLinkEnv } from "../link-env.js";
import { collectLinkOccurrences, readExtraComponents } from "../link-occurrences.js";
import {
  isExternalUrl,
  isRelativeUrl,
  isUnderOpaqueNamespace,
  resolveLink,
} from "../link-resolver.js";
import type { Rule } from "../rule.js";

export const redirectedLink: Rule = {
  code: "nimbus/redirected-link",
  run(ctx) {
    // Same draft skip as `internal-link`: drafts aren't in route truth.
    if (ctx.file.frontmatter?.draft === true) return;

    const env = loadLinkEnv(inferProjectRoot(ctx.file.absPath));
    if (!env) return;

    const ignore = ctx.options.ignore;
    const linkIgnore = ctx.optionsOf?.("nimbus/internal-link").ignore;
    const origin = siteOrigin(ctx.site);
    const components = readExtraComponents(ctx.options.components);

    for (const occ of collectLinkOccurrences(ctx.file.tree, components)) {
      const url = occ.url;
      if (!url || isExternalUrl(url) || isRelativeUrl(url)) continue;
      const key = linkRouteKey(url);
      if (matchesAnyIgnore(key, ignore) || isUnderOpaqueNamespace(env, key)) continue;

      const resolution = resolveLink(env, url, linkIgnore);
      if (resolution.kind === "broken" || !resolution.redirectedTo) continue;
      const { url: destination, offBase } = resolution.redirectedTo;
      if (offBase && origin === null) continue;
      const target = offBase ? `${origin}${destination}` : destination;
      ctx.report({
        message: `"${url}" redirects to "${target}" — link to the destination directly.`,
        line: occ.line,
        column: occ.column,
        fix: { description: `replace "${url}" with "${target}"`, edits: [] },
      });
    }
  },
};

function siteOrigin(site: string | undefined): string | null {
  if (!site) return null;
  try {
    return new URL(site).origin;
  } catch {
    return null;
  }
}
