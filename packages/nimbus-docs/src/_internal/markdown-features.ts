import type { Features } from "satteri";

/** What a site reads with before the integration says otherwise: Astro's defaults. */
export const DEFAULT_MARKDOWN_FEATURES: Readonly<Features> = {
  gfm: true,
  smartPunctuation: true,
};

const FEATURES_KEY = Symbol.for("nimbus-docs.markdown-features");

type FeaturesHost = { [FEATURES_KEY]?: Features };

/**
 * The Sätteri features the site renders with. Set by the integration (and by
 * the CLI from `.nimbus/lint.json`), so every internal parse reads the source
 * exactly as the page renders it. Held on `globalThis` for the build process:
 * dev and prerendering run there, and Workers serve prepared Markdown.
 */
export function setMarkdownFeatures(features: Features): void {
  (globalThis as FeaturesHost)[FEATURES_KEY] = features;
}

export function markdownFeatures(): Features {
  return (globalThis as FeaturesHost)[FEATURES_KEY] ?? DEFAULT_MARKDOWN_FEATURES;
}
