import { markdownToMdast, mdxToMdast } from "satteri";

import { markdownFeatures } from "./markdown-features.js";

/** Parse authored source with the features the site renders with. */
export function parseMarkdownSource(
  source: string,
  format: "markdown" | "mdx" = "mdx",
): ReturnType<typeof mdxToMdast> {
  const features = markdownFeatures();
  return format === "markdown"
    ? markdownToMdast(source, { features })
    : mdxToMdast(source, { features });
}
