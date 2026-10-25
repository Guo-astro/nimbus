import { isSatteriProcessor, satteri } from "@astrojs/markdown-satteri";
import type { Features, HastPluginInput, MdastPluginInput } from "satteri";

export function createDefaultMarkdownProcessor(options: {
  hastPlugins?: HastPluginInput[];
  mdastPlugins?: MdastPluginInput[];
  features?: Features;
}): ReturnType<typeof satteri> {
  return satteri({
    hastPlugins: options.hastPlugins ?? [],
    mdastPlugins: options.mdastPlugins ?? [],
    features: { ...options.features },
  });
}

/**
 * The features `processor` renders with, on top of Astro's `gfm` and
 * `smartypants`. A processor other than Sätteri gets Astro's two only.
 */
export function processorFeatures(
  processor: unknown,
  astro: { gfm: boolean; smartPunctuation: boolean },
): Features {
  const own =
    processor &&
    typeof processor === "object" &&
    isSatteriProcessor(processor as Parameters<typeof isSatteriProcessor>[0])
      ? (processor as ReturnType<typeof satteri>).options.features
      : undefined;
  return { ...astro, ...own };
}
