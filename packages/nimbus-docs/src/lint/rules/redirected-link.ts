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
import { isExternalUrl, resolveLinkCached } from "../link-resolver.js";
import type { Rule } from "../rule.js";
import { isRelative, isUnderOpaqueNamespace } from "./internal-link.js";

export const redirectedLink: Rule = {
  code: "nimbus/redirected-link",
  run(ctx) {
    // Same draft skip as `internal-link`: drafts aren't in route truth.
    if (ctx.file.frontmatter?.draft === true) return;

    const env = loadLinkEnv(inferProjectRoot(ctx.file.absPath));
    if (!env) return;

    // Raw arrays: the glob matcher and resolver memo key on identity.
    const ignore = ctx.options.ignore;
    const linkOptions = ctx.optionsOf?.("nimbus/internal-link") ?? {};
    const resolveOptions = { ignore: linkOptions.ignore };
    const extraComponents = readExtraComponents(ctx.options.components);

    for (const occ of collectLinkOccurrences(ctx.file.tree, extraComponents)) {
      const url = occ.url;
      if (!url || isExternalUrl(url) || isRelative(url)) continue;
      const key = linkRouteKey(url);
      if (matchesAnyIgnore(key, ignore)) continue;
      if (isUnderOpaqueNamespace(key, env.opaqueNamespaces)) continue;

      const resolution = resolveLinkCached(env, url, resolveOptions);
      if (resolution.kind === "broken" || resolution.redirectedTo === undefined) continue;
      const { url: destination, offBase } = resolution.redirectedTo;
      const origin = offBase ? siteOrigin(ctx.site) : "";
      if (origin === null) continue;
      const target = `${origin}${destination}`;
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
