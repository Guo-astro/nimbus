/**
 * Detect a `.nimbus/lint.json` written before the lint rules last changed.
 * The Astro config is read as text (never executed); when its `rules` or
 * `collections` aren't literals we can't tell, so we say nothing.
 */

import { parseNimbusOptions } from "../_internal/parse-nimbus-config.js";
import { validateLintOptions, type ValidatedLintOptions } from "./config.js";
import { IMPLEMENTED_CODES } from "./rules/index.js";

export const STALE_LINT_CONFIG_MESSAGE =
  "Lint rules changed since .nimbus/lint.json was written; these results use the old rules. " +
  "Run `astro sync` to apply them.";

/** True when the Astro config's lint rules differ from the materialized ones. */
export function lintConfigIsStale(cwd: string, materialized: ValidatedLintOptions): boolean {
  const parsed = parseNimbusOptions(cwd);
  if (!parsed.ok) return false;
  if (parsed.unresolved.some((key) => key === "rules" || key === "collections" || key === "...spread")) {
    return false;
  }
  let current: ValidatedLintOptions;
  try {
    current = validateLintOptions(
      { rules: parsed.options.rules, collections: parsed.options.collections },
      IMPLEMENTED_CODES,
    );
  } catch {
    // An invalid config fails the next build with its own message.
    return false;
  }
  return stableJson(current) !== stableJson(materialized);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
