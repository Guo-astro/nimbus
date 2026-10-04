/**
 * Every authored link in a file, for the link rules: Markdown links,
 * reference links, MDX `<a href>`, and components from the `components`
 * option.
 */

import { collect, startOf, visit, type MdNode } from "./parse.js";

export interface LinkOccurrence {
  url: string;
  line: number;
  column: number;
}

export interface ComponentSpec {
  name: string;
  attr: string;
}

/**
 * `<a href>` is always checked — plain anchors mean the same thing in
 * every MDX file. Extra components come from the `components` option.
 */
export function readExtraComponents(value: unknown): ComponentSpec[] {
  if (!Array.isArray(value)) return [];
  const out: ComponentSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { name?: unknown; attr?: unknown };
    if (typeof obj.name === "string" && typeof obj.attr === "string") {
      out.push({ name: obj.name, attr: obj.attr });
    }
  }
  return out;
}

/**
 * Collect every link from the tree, normalized into one shape so a rule's
 * main loop doesn't fork on node type.
 */
export function collectLinkOccurrences(
  root: MdNode,
  extraComponents: ComponentSpec[],
): LinkOccurrence[] {
  const definitions = collectDefinitions(root);
  const out: LinkOccurrence[] = [];
  visit(root, (node) => {
    if (node.type === "link") {
      const at = startOf(node);
      out.push({
        url: typeof node.url === "string" ? node.url : "",
        line: at.line,
        column: at.column,
      });
      return;
    }
    if (node.type === "linkReference") {
      const identifier =
        typeof node.identifier === "string" ? node.identifier : "";
      const url = definitions.get(identifier);
      if (!url) return;
      const at = startOf(node);
      out.push({ url, line: at.line, column: at.column });
      return;
    }
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      if (node.name === "a") {
        const href = readJsxStringAttr(node, "href");
        if (href === null) return;
        const at = startOf(node);
        out.push({ url: href, line: at.line, column: at.column });
        return;
      }
      for (const spec of extraComponents) {
        if (node.name !== spec.name) continue;
        const href = readJsxStringAttr(node, spec.attr);
        if (href === null) return;
        const at = startOf(node);
        out.push({ url: href, line: at.line, column: at.column });
        return;
      }
    }
  });
  return out;
}

export function collectDefinitions(root: MdNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of collect(root, "definition")) {
    const id = typeof def.identifier === "string" ? def.identifier : "";
    const url = typeof def.url === "string" ? def.url : "";
    if (id && url && !out.has(id)) out.set(id, url);
  }
  return out;
}

/**
 * Read a string-valued JSX attribute. Returns null when the attribute is
 * absent, dynamic (expression form `<a href={x}>`), or boolean (`<a
 * disabled>`). Static-only on purpose — dynamic hrefs aren't link-checkable.
 */
function readJsxStringAttr(node: MdNode, name: string): string | null {
  const attrs = (node as { attributes?: unknown }).attributes;
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    if (!a || typeof a !== "object") continue;
    const attr = a as { name?: unknown; value?: unknown };
    if (attr.name !== name) continue;
    if (typeof attr.value === "string") return attr.value;
    return null;
  }
  return null;
}
