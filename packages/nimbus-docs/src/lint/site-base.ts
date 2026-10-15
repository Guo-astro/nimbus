/**
 * The deployment base lint checks image paths against, in the renderer's
 * form (`"/docs"`, or `""` at the root). `.nimbus/lint.json` carries it from
 * `astro sync`, `dev` and `build`; an older file falls back to the base in
 * `.nimbus/routes.json`. With neither, lint checks as if the site had no base
 * and says so.
 */

import { basePrefix } from "../_internal/authored-links.js";
import { readRouteTruth } from "./route-truth.js";

export const UNKNOWN_SITE_BASE_MESSAGE =
  "Couldn't read the site base (run `astro sync`); image paths were checked as if the site had none.";

export const BASE_FROM_ROUTES_MESSAGE =
  "`.nimbus/lint.json` is from an older build without the site base, so image paths were checked " +
  "against the base in `.nimbus/routes.json`. Run `astro sync` to record it.";

export interface LintBase {
  base: string;
  /** False when no base was found and `base` is the `""` fallback. */
  known: boolean;
}

export function resolveLintBase(projectRoot: string, materialized: string | undefined): LintBase {
  if (materialized !== undefined) return { base: materialized, known: true };
  const { truth } = readRouteTruth(projectRoot);
  const fromRoutes = truth?.base ? normalizeBase(truth.base) : undefined;
  return fromRoutes === undefined ? { base: "", known: false } : { base: fromRoutes, known: true };
}

/** Astro's `base` as written (`"docs"`, `"/docs/"`) in the renderer's form, or undefined when invalid. */
export function normalizeBase(base: string): string | undefined {
  try {
    return basePrefix(base.startsWith("/") ? base : `/${base}`);
  } catch {
    return undefined;
  }
}
