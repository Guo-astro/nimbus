import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ADAPTER_RECIPES,
  ASTRO_CONFIG_FILENAMES,
  applyAdapterToConfig,
  buildServerWranglerConfig,
  sanitizeWorkerName,
  workersCompatibilityDate,
  type AdapterId,
} from "@cloudflare/nimbus-docs/adapters";
import { ScaffoldError } from "../scaffold.js";

// Build output an adapter's platform writes into the project root; ignore it so
// a fresh `git init` doesn't stage it. Cloudflare's `.wrangler/` is already in
// the shipped .gitignore, so it needs nothing here.
const IGNORE_ENTRIES_BY_ADAPTER: Partial<Record<AdapterId, string[]>> = {
  vercel: [".vercel/"],
  netlify: [".netlify/"],
};

/**
 * Flip the scaffolded `astro.config` to server output and wire the adapter.
 * Fail-closed: a missing marker, missing/altered `output`, or a pre-wired
 * adapter aborts the scaffold with the framework's actionable message rather
 * than shipping a half-configured project.
 *
 * Discovery follows Astro's own resolution order and supported set
 * (`ASTRO_CONFIG_FILENAMES`); `.cjs` is intentionally absent, so the ESM
 * `import` the edit inserts can never be written into a CommonJS config.
 */
export async function applyAdapter(dir: string, adapter: AdapterId): Promise<void> {
  const configPath = ASTRO_CONFIG_FILENAMES.map((f) => join(dir, f)).find(existsSync);
  if (!configPath) {
    throw new ScaffoldError(
      `The template has no astro.config to enable server output in (looked for ${ASTRO_CONFIG_FILENAMES.join(", ")}).`,
    );
  }

  // A new server site renders its docs on request, so content negotiation and
  // agent headers work from the first deploy. Off Cloudflare that's the docs
  // collection only: generated API pages render on request only there.
  const result = applyAdapterToConfig(readFileSync(configPath, "utf-8"), adapter, {
    requestRendering: adapter === "cloudflare" ? true : { collections: ["docs"] },
  });
  if (result.status !== "error" && result.requestRendering === "unresolved") {
    throw new ScaffoldError(
      "The template's Nimbus config is customized, so request rendering cannot be enabled safely.",
    );
  }
  if (result.status === "applied") {
    writeFileSync(configPath, result.source);
    return;
  }
  // A fresh template is never pre-wired, but treat idempotent success as success.
  if (result.status === "noop") return;

  throw new ScaffoldError(`Could not enable the "${adapter}" adapter: ${result.message}`);
}

/**
 * Write the user-facing server `wrangler.jsonc` for an adapter that ships one
 * (Cloudflare today), via the same shared emitter and serialization the CLI
 * opt-in uses. Worker name and `compatibility_date` are freshly derived here
 * (from the dir name and the Workers runtime the project will install,
 * `workersCompatibilityDate`), so this file — unlike astro.config —
 * is not guaranteed byte-identical to a later `add adapter-<id>`. No-op for
 * adapters whose platform owns its own deploy config.
 */
export async function writeServerWrangler(dir: string, adapter: AdapterId): Promise<void> {
  const recipe = ADAPTER_RECIPES[adapter];
  if (!recipe.serverWrangler) return;
  const cfg = buildServerWranglerConfig(recipe, {
    name: sanitizeWorkerName(basename(dir)),
    compatibilityDate: await workersCompatibilityDate(dir),
  })!;
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(cfg, null, 2) + "\n");
}

/** Append an adapter's platform build-output dir to the project's .gitignore. */
export function appendAdapterIgnoreEntries(dir: string, adapter: AdapterId): void {
  const entries = IGNORE_ENTRIES_BY_ADAPTER[adapter];
  if (!entries || entries.length === 0) return;

  const gitignorePath = join(dir, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, existing + prefix + missing.join("\n") + "\n");
}
