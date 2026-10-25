/**
 * Rendered content shown inside another page's outline, such as a release
 * body on a changelog list: its headings move under the host's heading and
 * lose their ids (the host may show many bodies with the same sections), and
 * links to those ids go to the page where the sections live.
 */
import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";

type Root = ReturnType<typeof fromHtml>;
type Node = Root | Root["children"][number];
type Element = Extract<Node, { type: "element" }>;

export interface NestedContentOptions {
  /**
   * The level the content's `h1` and `h2` both become. Deeper headings keep
   * their offset from `h2`, down to `h6`: with `4`, `h3` becomes `h5`.
   */
  headingLevel: 1 | 2 | 3 | 4 | 5 | 6;
  /** The page the content comes from: links to its sections go there. */
  sourceUrl?: string;
}

const HEADING = /^h([1-6])$/;

function walk(node: Node, visit: (element: Element) => void): void {
  if (node.type === "element") visit(node);
  if ("children" in node) for (const child of node.children) walk(child as Node, visit);
}

export function nestContent(html: string, options: NestedContentOptions): string {
  const top = options.headingLevel;
  const tree: Root = fromHtml(html, { fragment: true });
  const removed = new Set<string>();
  walk(tree, (element) => {
    const depth = HEADING.exec(element.tagName)?.[1];
    if (!depth) return;
    element.tagName = `h${Math.min(6, Math.max(top, Number(depth) + top - 2))}`;
    const id = element.properties.id;
    if (typeof id === "string") removed.add(id);
    delete element.properties.id;
  });
  if (options.sourceUrl && removed.size > 0) {
    walk(tree, (element) => {
      const href = element.properties.href;
      if (typeof href !== "string" || !href.startsWith("#")) return;
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {}
      if (removed.has(id)) element.properties.href = `${options.sourceUrl}${href}`;
    });
  }
  return toHtml(tree);
}
