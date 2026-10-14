/**
 * @internal
 *
 * Public-but-unstable subpath (`@cloudflare/nimbus-docs/adapters`). It exists so
 * `@cloudflare/create-nimbus-docs` can run the *exact* server-output opt-in the
 * `nimbus-docs add adapter-*` CLI runs — the config edit + adapter recipe + the
 * Cloudflare server-wrangler emitter — without forking the transform. The
 * scaffolder bundles it at build time. Fresh server scaffolds additionally
 * enable request rendering (every collection on Cloudflare, docs elsewhere)
 * when the project has not declared an explicit rendering policy;
 * `add adapter-*` does that only for Cloudflare.
 *
 * Curated re-export, never `export *`: the internal-only helpers (config
 * classifiers, idempotency detectors, id list) stay private. No external
 * stability guarantee — this surface tracks the scaffolder, not semver.
 */
export {
  ADAPTER_MARKER,
  ADAPTER_RECIPES,
  ASTRO_CONFIG_FILENAMES,
  applyAdapterToConfig,
  buildServerWranglerConfig,
  sanitizeWorkerName,
  workersCompatibilityDate,
} from "./_internal/adapters.js";
export type {
  AdapterId,
  AdapterRecipe,
  ApplyAdapterResult,
  RequestRenderingEdit,
  ServerWranglerRecipe,
  WranglerInputs,
} from "./_internal/adapters.js";
