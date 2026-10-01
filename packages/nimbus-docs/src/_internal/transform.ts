/**
 * MDX → Markdown transform for generated static routes.
 *
 * The body is parsed with Sätteri, the parser that renders the site's HTML,
 * so the Markdown and the page agree on structure: which list item a code
 * block belongs to, which callout holds which list. Each top-level block that
 * contains a component is rebuilt as Markdown from its tree (an `<Aside>`
 * becomes a blockquote, `<Steps>` an ordered list, …) and serialized; every
 * other block keeps the author's bytes. The route that calls this lives in
 * user code, so replacing or bypassing this transformer is a one-line edit.
 */

import { gfmToMarkdown } from "mdast-util-gfm";
import { mdxToMarkdown } from "mdast-util-mdx";
import { toMarkdown } from "mdast-util-to-markdown";

import {
  hasCitation,
  resolveCitations,
  type CitationIndex,
} from "./api/citations.js";
import { getTabs, isCommandType } from "../lib/pkgm.js";

export interface MarkdownComponentRenderContext {
  name: string;
  attrs: Record<string, string | boolean>;
  children: string;
  base: string;
}

export type MarkdownComponentRenderer = (
  context: MarkdownComponentRenderContext,
) => string;

export interface RenderEntryAsMarkdownOptions {
  /**
   * Override how specific MDX components are rendered. Keys are component
   * names (e.g. `Aside`, `Tabs`, `PackageManagers`).
   */
  componentMap?: Record<string, MarkdownComponentRenderer>;
  /** Strip YAML frontmatter if the raw body includes it. Default: true. */
  stripFrontmatter?: boolean;
  /**
   * Coordinate-citation index. Required when the body contains `api.ref:`
   * citations, else rendering throws rather than emitting a raw sentinel.
   */
  citationIndex?: CitationIndex;
  /** Active Astro base path for build-time component renderers. */
  base?: string;
}

interface MarkdownEntry {
  body?: string;
  filePath?: string;
}

/** An mdast node, as Sätteri produces it. Structural on purpose. */
interface MdNode {
  type: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
}

interface JsxAttribute {
  type: string;
  name?: string;
  value?: string | null | { type: string; value: string };
}

interface JsxElement extends MdNode {
  name: string | null;
  attributes: JsxAttribute[];
  children: MdNode[];
}

interface Context {
  componentMap: Record<string, MarkdownComponentRenderer>;
  base: string;
  /** The body being rendered: node offsets index into it. */
  source: string;
}

interface Parsers {
  mdxToMdast: (source: string) => MdNode;
  markdownToMdast: (source: string) => MdNode;
}
let parsers: Parsers | undefined;

/**
 * Sätteri is native code, so it's loaded on first use and never by an
 * import: this module is also bundled into server builds (it's part of
 * `/runtime`), where nothing renders Markdown from MDX.
 */
function satteri(): Parsers {
  if (!parsers) {
    const moduleApi = globalThis.process?.getBuiltinModule?.("node:module");
    if (!moduleApi) {
      throw new Error(
        "nimbus-docs: renderEntryAsMarkdown needs Node, which builds and prerendering provide. " +
          "Serve request-time Markdown from the build's prepared Markdown instead.",
      );
    }
    parsers = moduleApi.createRequire(import.meta.url)("satteri") as Parsers;
  }
  return parsers;
}

const isJsx = (node: MdNode): node is JsxElement =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

/** A component (PascalCase, or one the site renders), not an HTML element. */
const isComponent = (node: JsxElement, ctx: Context): boolean =>
  node.name !== null && (/^[A-Z]/.test(node.name) || node.name in ctx.componentMap);

function containsComponent(node: MdNode, ctx: Context): boolean {
  if (isJsx(node) && (node.name === null || isComponent(node, ctx))) return true;
  return node.children?.some((child) => containsComponent(child, ctx)) ?? false;
}

const LITERAL = /^\s*(["'`])([^"'`$]*)\1\s*$/;

/** Whether `node` holds a string expression (JSX's `{" "}`), written as text. */
function containsLiteralExpression(node: MdNode): boolean {
  if ((node.type === "mdxTextExpression" || node.type === "mdxFlowExpression") && LITERAL.test(String(node.value))) return true;
  return node.children?.some(containsLiteralExpression) ?? false;
}

function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node);
  node.children?.forEach((child) => walk(child, visit));
}

// ── attributes ─────────────────────────────────────────────────────────────

/** Every attribute as the renderer API has always given it: strings, `true`
 * for a bare flag, and an expression's source. */
function attributesOf(node: JsxElement): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  for (const attribute of node.attributes) {
    if (attribute.type !== "mdxJsxAttribute" || !attribute.name) continue;
    const value = attribute.value;
    attrs[attribute.name] =
      value === null || value === undefined ? true : typeof value === "string" ? value : value.value.trim();
  }
  return attrs;
}

/** A text attribute: a string, or a string-literal expression (`{"Setup"}`).
 * A title written as code (`{t("k")}`) has no text to show. */
function textAttribute(node: JsxElement, name: string): string | undefined {
  const attribute = node.attributes.find((a) => a.type === "mdxJsxAttribute" && a.name === name);
  const value = attribute?.value;
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const literal = /^\s*(["'`])([^"'`$]*)\1\s*$/.exec(value.value);
    return literal?.[2]?.trim() || undefined;
  }
  return undefined;
}

// ── node builders ──────────────────────────────────────────────────────────

const text = (value: string): MdNode => ({ type: "text", value });
const strong = (value: string): MdNode => ({ type: "strong", children: [text(value)] });
const paragraph = (children: MdNode[]): MdNode => ({ type: "paragraph", children });

// A card renders as a one-item list; consecutive cards join into one list.
const CARD = "nimbusCard";
const isCardList = (node: MdNode | undefined) =>
  (node?.data as Record<string, unknown> | undefined)?.[CARD] === true;

function cardList(content: MdNode[]): MdNode {
  return {
    type: "list",
    ordered: false,
    spread: false,
    data: { [CARD]: true },
    children: [{ type: "listItem", spread: content.length > 1, children: content }],
  };
}

/** A card's title, then its body: one paragraph follows the title on its
 * line; anything more (a list, several paragraphs) goes below it. */
function cardContent(title: MdNode, body: MdNode[]): MdNode[] {
  if (body.length === 0) return [paragraph([title])];
  if (body.length === 1 && body[0]!.type === "paragraph") {
    return [paragraph([title, text(" — "), ...(body[0]!.children ?? [])])];
  }
  return [paragraph([title]), ...body];
}

function joinCardLists(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (isCardList(node) && isCardList(previous)) {
      previous!.children = [...previous!.children!, ...node.children!];
    } else {
      out.push(node);
    }
  }
  return out;
}

function packageManagersCode(attrs: Record<string, string | boolean>): MdNode[] {
  const asString = (value: string | boolean | undefined) => (typeof value === "string" ? value : undefined);
  const type = asString(attrs.type) ?? "add";
  if (!isCommandType(type)) return [];
  const comment = asString(attrs.comment);
  const commands = getTabs(type, asString(attrs.pkg), {
    args: asString(attrs.args),
    dev: attrs.dev === true || attrs.dev === "true",
  }).map((tab) => tab.cmd);
  if (commands.length === 0) return [];
  const value = [...(comment ? [`# ${comment}`] : []), ...commands].join("\n");
  return [{ type: "code", lang: "sh", meta: null, value }];
}

// ── transform ──────────────────────────────────────────────────────────────

function transformChildren(nodes: MdNode[], ctx: Context): MdNode[] {
  return joinCardLists(nodes.flatMap((node) => transformNode(node, ctx)));
}

const PHRASING = new Set([
  "text", "emphasis", "strong", "delete", "inlineCode", "break", "link", "linkReference",
  "image", "imageReference", "footnoteReference", "mdxJsxTextElement", "mdxTextExpression",
]);

/**
 * A block component's content as blocks. Written on one line
 * (`<TabItem label="A">One.</TabItem>`), it is inline text; each run of
 * inline nodes becomes a paragraph.
 */
function asBlocks(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  let run: MdNode[] = [];
  const flush = () => {
    if (run.some((node) => node.type !== "text" || String(node.value).trim())) out.push(paragraph(run));
    run = [];
  };
  for (const node of nodes) {
    if (PHRASING.has(node.type)) run.push(node);
    else {
      flush();
      out.push(node);
    }
  }
  flush();
  return out;
}

/** A block element's children, rendered, as blocks. One that is only a block
 * component (`<div><Aside>…</Aside></div>` on one line) holds that component. */
function blockChildren(node: JsxElement, ctx: Context): MdNode[] {
  const only = soleChild(node.children);
  if (only && isJsx(only) && only.name !== null && BLOCK_COMPONENTS.has(only.name)) {
    return renderElement({ ...only, type: "mdxJsxFlowElement" }, ctx);
  }
  return asBlocks(transformChildren(node.children, ctx));
}

function transformNode(node: MdNode, ctx: Context): MdNode[] {
  if (isJsx(node)) return renderElement(node, ctx);
  // A string expression (JSX's `{" "}`) is just its text.
  if (node.type === "mdxTextExpression" || node.type === "mdxFlowExpression") {
    const literal = LITERAL.exec(String(node.value));
    if (literal) return [text(literal[2]!)];
  }
  if (!node.children) return [node];
  // A paragraph that is only a block component (`<div><Aside>…</Aside></div>`
  // on one line) is that component.
  const only = node.type === "paragraph" ? soleChild(node.children) : undefined;
  if (only && isJsx(only) && only.name !== null && BLOCK_COMPONENTS.has(only.name)) {
    return renderElement({ ...only, type: "mdxJsxFlowElement" }, ctx);
  }
  const children = hoistEdgeSpaces(transformChildren(node.children, ctx));
  return [{ ...node, children: TEXT_BLOCKS.has(node.type) ? trimEdges(children) : children }];
}

const BLOCK_COMPONENTS = new Set(["Aside", "Card", "CardGrid", "LinkCard", "PackageManagers", "Steps", "Tabs"]);

function soleChild(children: MdNode[]): MdNode | undefined {
  const meaningful = children.filter((child) => child.type !== "text" || String(child.value).trim());
  return meaningful.length === 1 ? meaningful[0] : undefined;
}

const SPACED = new Set(["strong", "emphasis", "delete", "link"]);

/**
 * Spaces at the inner edges of emphasis (`**<Badge> bold </Badge>**`, once the
 * component is gone) move outside it: inside, the serializer encodes them as
 * `&#x20;`.
 */
function hoistEdgeSpaces(children: MdNode[]): MdNode[] {
  const spaceAt = (node: MdNode | undefined, edge: "start" | "end") =>
    node?.type === "text" && (edge === "start" ? /^\s/ : /\s$/).test(String(node.value));
  return children.flatMap((node, index) => {
    if (!SPACED.has(node.type) || !node.children?.length) return [node];
    const inner = [...node.children];
    const first = inner[0]!;
    const before = first.type === "text" ? /^\s+/.exec(String(first.value))?.[0] : undefined;
    if (before) inner[0] = { ...first, value: String(first.value).slice(before.length) };
    const tail = inner[inner.length - 1]!;
    const after = tail.type === "text" ? /\s+$/.exec(String(tail.value))?.[0] : undefined;
    if (after) inner[inner.length - 1] = { ...tail, value: String(tail.value).slice(0, -after.length) };
    const lead = before && !spaceAt(children[index - 1], "end") ? [text(" ")] : [];
    const trail = after && !spaceAt(children[index + 1], "start") ? [text(" ")] : [];
    return [...lead, { ...node, children: inner }, ...trail];
  });
}

const TEXT_BLOCKS = new Set(["paragraph", "heading", "tableCell"]);

/**
 * Drop the spaces a removed component leaves at a line's edges
 * (`## Setup <Badge />`): kept, the serializer encodes them as `&#x20;`.
 */
function trimEdges(children: MdNode[]): MdNode[] {
  // Adjacent text (a `{" "}` that became a space) joins, and spaces before a
  // soft line break go: a hard break is its own `break` node.
  const out: MdNode[] = [];
  for (const node of children) {
    const previous = out[out.length - 1];
    if (node.type === "text" && previous?.type === "text") {
      out[out.length - 1] = { ...previous, value: String(previous.value) + String(node.value) };
    } else {
      out.push(node);
    }
  }
  for (const [index, node] of out.entries()) {
    if (node.type === "text") out[index] = { ...node, value: String(node.value).replace(/[ \t]+\n/g, "\n") };
  }
  const first = out[0];
  if (first?.type === "text") out[0] = { ...first, value: String(first.value).replace(/^\s+/, "") };
  const last = out[out.length - 1];
  if (last?.type === "text") out[out.length - 1] = { ...last, value: String(last.value).replace(/\s+$/, "") };
  return out.filter((node) => node.type !== "text" || node.value !== "");
}

const elementsNamed = (nodes: MdNode[], name: string): JsxElement[] =>
  nodes.filter((node): node is JsxElement => isJsx(node) && node.name === name);

function renderElement(node: JsxElement, ctx: Context): MdNode[] {
  const inline = node.type === "mdxJsxTextElement";
  const children = () => (inline ? transformChildren(node.children, ctx) : blockChildren(node, ctx));
  if (node.name === null) return children();

  const custom = ctx.componentMap[node.name];
  if (custom) {
    const rendered = custom({
      name: node.name,
      attrs: attributesOf(node),
      children: serialize(children()),
      base: ctx.base,
    });
    return rendered ? [{ type: "html", value: rendered }] : [];
  }

  // HTML elements stay as written, with their content rendered as Markdown.
  if (!isComponent(node, ctx)) return htmlElement(node, children(), ctx);
  // Mid-sentence (in a table cell, a heading, a sentence), a component keeps
  // what it says, in inline form.
  if (inline) return inlineForm(node, children());

  switch (node.name) {
    case "PackageManagers":
      return packageManagersCode(attributesOf(node));
    case "Aside":
      return [{ type: "blockquote", children: [paragraph([strong(asideTitle(node))]), ...children()] }];
    case "Card":
      return [cardList(cardContent(strong(textAttribute(node, "title") ?? "Card"), children()))];
    case "CardGrid":
      return children();
    case "LinkCard":
      return [cardList([paragraph(linkCardText(node))])];
    case "Steps": {
      const start = Number(attributesOf(node).start);
      const steps = elementsNamed(node.children, "Step");
      if (steps.length === 0) {
        // The usual form wraps a Markdown ordered list; `start` offsets its count.
        const blocks = children();
        const list = blocks.find((block) => block.type === "list" && block.ordered);
        if (list && Number.isInteger(start) && start > 0) list.start = start;
        return blocks;
      }
      return [
        {
          type: "list",
          ordered: true,
          start: Number.isInteger(start) && start > 0 ? start : 1,
          spread: false,
          children: steps.map((step, index) => {
            const body = blockChildren(step, ctx);
            const title = textAttribute(step, "title") ?? `Step ${index + 1}`;
            return { type: "listItem", spread: body.length > 0, children: [paragraph([strong(title)]), ...body] };
          }),
        },
      ];
    }
    case "Tabs":
      return elementsNamed(node.children, "TabItem").flatMap((tab) => [
        { type: "heading", depth: 3, children: [text(textAttribute(tab, "label") ?? "Option")] },
        ...blockChildren(tab, ctx),
      ]);
    default:
      // A component without a Markdown form keeps its content. Its attributes
      // are dropped: a `title` is often only a tooltip.
      return children();
  }
}

function asideTitle(node: JsxElement): string {
  const type = (textAttribute(node, "type") ?? "note").toLowerCase();
  return textAttribute(node, "title") ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function linkCardText(node: JsxElement): MdNode[] {
  const title = textAttribute(node, "title") ?? "Link";
  const href = textAttribute(node, "href");
  const description = textAttribute(node, "description");
  const label: MdNode = href ? { type: "link", url: href, title: null, children: [text(title)] } : strong(title);
  return [label, ...(description ? [text(` — ${description}`)] : [])];
}

/** A component's inline form, for a table cell, a heading, or a sentence. */
function inlineForm(node: JsxElement, content: MdNode[]): MdNode[] {
  const then = (separator: string) => (content.length > 0 ? [text(separator), ...content] : []);
  switch (node.name) {
    case "Aside":
      return [strong(asideTitle(node)), ...then(" ")];
    case "Card":
      return [strong(textAttribute(node, "title") ?? "Card"), ...then(" — ")];
    case "LinkCard":
      return linkCardText(node);
    case "PackageManagers": {
      const [code] = packageManagersCode(attributesOf(node));
      return code ? [{ type: "inlineCode", value: String(code.value).split("\n").filter((line) => !line.startsWith("#"))[0] }] : [];
    }
    default:
      return content;
  }
}

function sourceOf(node: MdNode, ctx: Context): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : ctx.source.slice(start, end);
}

/** Lines after the first, less the indentation they share (a list item's). */
function dedent(source: string): string {
  const [first, ...rest] = source.split("\n");
  const indents = rest.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return [first, ...rest.map((line) => line.slice(common))].join("\n");
}

const STRUCTURE = new Set(["heading", "list", "blockquote", "code", "table", "thematicBreak"]);
const structureIn = (node: MdNode): number =>
  (STRUCTURE.has(node.type) ? 1 : 0) + (node.children ?? []).reduce((sum, child) => sum + structureIn(child), 0);

/**
 * Whether Markdown would read `written` (an HTML element as written) with less
 * structure than MDX does: without blank lines, `<div>\n## Title` is one HTML
 * block, and the heading becomes literal text.
 */
function losesStructure(node: MdNode, written: string): boolean {
  const inMdx = structureIn(node);
  return inMdx > 0 && structureIn(satteri().markdownToMdast(dedent(written))) < inMdx;
}

/** The source text of `node`'s opening tag. */
function openingTag(node: JsxElement, ctx: Context): string {
  const start = node.position?.start.offset;
  const contentStart = node.children[0]?.position?.start.offset ?? node.position?.end.offset;
  if (start === undefined || contentStart === undefined) return `<${node.name}>`;
  const source = ctx.source.slice(start, contentStart).trim();
  return source.endsWith(">") ? source.slice(0, source.lastIndexOf(">") + 1) : `<${node.name}>`;
}

/**
 * An HTML element around Markdown: inline, it stays an element; as a block,
 * its tags become their own blocks, so the blank lines around them end the
 * HTML block and the content between reads as Markdown.
 */
function htmlElement(node: JsxElement, content: MdNode[], ctx: Context): MdNode[] {
  if (node.type === "mdxJsxTextElement") return [{ ...node, children: content }];
  // With no component inside, the element is kept as written. Inside a
  // blockquote its lines carry `>` markers, so it's rebuilt instead.
  const written = sourceOf(node, ctx);
  if (written !== undefined && !containsComponent(node, ctx) && !/\n[ \t]*>/.test(written) && !losesStructure(node, written)) {
    return [{ type: "html", value: dedent(written) }];
  }
  const open = openingTag(node, ctx);
  if (node.children.length === 0 && open.endsWith("/>")) return [{ type: "html", value: open }];
  return [{ type: "html", value: open }, ...content, { type: "html", value: `</${node.name}>` }];
}

let extensions: ReturnType<typeof mdxToMarkdown>[] | undefined;

function serialize(nodes: MdNode[]): string {
  const root = { type: "root", children: nodes } as unknown as Parameters<typeof toMarkdown>[0];
  // Unpadded tables: column alignment only adds bytes for an agent to read.
  extensions ??= [gfmToMarkdown({ tablePipeAlign: false }), mdxToMarkdown()];
  return toMarkdown(root, {
    extensions,
    bullet: "-",
    listItemIndent: "one",
    fences: true,
    fence: "`",
    rule: "-",
    resourceLink: false,
  }).trimEnd();
}

/**
 * Render an Astro content entry's raw MDX body as plain markdown.
 *
 * This handles the starter's default MDX components. Users can pass a
 * `componentMap` to override individual component renderers or replace this
 * function entirely from their user-owned `.md` route.
 */
export function renderEntryAsMarkdown(
  entry: MarkdownEntry,
  options: RenderEntryAsMarkdownOptions = {},
): string {
  const stripFrontmatter = options.stripFrontmatter ?? true;
  let markdown = entry.body ?? "";
  const isMdx = !entry.filePath?.endsWith(".md");

  if (stripFrontmatter) {
    markdown = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
  }

  if (hasCitation(markdown)) {
    if (!options.citationIndex) {
      throw new Error(
        "nimbus-docs: renderEntryAsMarkdown received a body with api.ref: " +
          "citations but no citation index. Use getEntryMarkdown, or pass " +
          "`{ citationIndex: await loadCitationIndex() }`.",
      );
    }
    markdown = resolveCitations(markdown, {
      mode: "derived",
      citationIndex: options.citationIndex,
    }).code;
  }

  if (!isMdx) return markdown.trim();

  const { mdxToMdast, markdownToMdast } = satteri();
  const tree = mdxToMdast(markdown);
  walk(tree, (node) => {
    if (isJsx(node) && node.name === "Render") {
      throw new Error(
        "nimbus-docs: renderEntryAsMarkdown no longer expands <Render> partials at runtime. " +
          "Serve it with getMarkdownPayload from @cloudflare/nimbus-docs/agent-endpoints.",
      );
    }
  });

  // A block keeps the author's bytes when they mean the same in Markdown as
  // in MDX. One with a component, or one Markdown reads differently (MDX has
  // no indented code, so a deeply indented fence is still a fence), is
  // rebuilt from the MDX tree.
  const ctx: Context = { componentMap: options.componentMap ?? {}, base: options.base ?? "/", source: markdown };
  const asMarkdown = (markdownToMdast(markdown).children ?? []).filter((node) => node.position);
  let next = 0; // both trees are in document order: one pass over Markdown's nodes
  let out = "";
  let cursor = 0;
  for (const block of tree.children ?? []) {
    const start = block.position?.start.offset;
    const end = block.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const nodes: MdNode[] = [];
    while (next < asMarkdown.length && asMarkdown[next]!.position!.end.offset! <= start) next++;
    for (let i = next; i < asMarkdown.length && asMarkdown[i]!.position!.start.offset! < end; i++) nodes.push(asMarkdown[i]!);
    // `import` / `export` lines are code for the page, not content.
    if (block.type === "mdxjsEsm") {
      out += markdown.slice(cursor, start).trimEnd();
      cursor = end;
      continue;
    }
    const keep = OPAQUE.has(block.type)
      ? !(isJsx(block) && losesStructure(block, markdown.slice(start, end)))
      : readsTheSame(block, nodes, start, end);
    if (!containsComponent(block, ctx) && !containsLiteralExpression(block) && keep) continue;
    const rendered = serialize(transformNode(block, ctx));
    // A block that renders to nothing takes one of its blank-line gaps with it.
    out += rendered ? markdown.slice(cursor, start) + rendered : markdown.slice(cursor, start).trimEnd();
    cursor = end;
  }
  out += markdown.slice(cursor);
  return out.trim();
}

// MDX-only syntax: Markdown reads it as HTML or text, so it can't be compared.
const OPAQUE = new Set(["mdxJsxFlowElement", "mdxJsxTextElement", "mdxFlowExpression", "mdxjsEsm", "html"]);

/** Whether Markdown parses `block`'s text (offsets `start` to `end`) into
 * the same structure: `nodes`, the Markdown nodes overlapping it, must lie
 * inside it and have its shape. */
function readsTheSame(block: MdNode, nodes: MdNode[], start: number, end: number): boolean {
  const inside = nodes.every((node) => node.position!.start.offset! >= start && node.position!.end.offset! <= end);
  return inside && nodes.map(shape).join(",") === shape(block);
}

/** A block's structure: its flow nodes, without the text inside them. */
function shape(node: MdNode): string {
  if (OPAQUE.has(node.type)) return "x";
  const flow = (node.children ?? []).filter((child) => FLOW.has(child.type) || OPAQUE.has(child.type));
  // A fence and an indented code block are both `code`; only a fence has a language.
  const kind =
    node.type === "list" ? `list${node.ordered ? "1" : "0"}` : node.type === "code" ? `code:${node.lang ?? ""}` : node.type;
  return flow.length > 0 ? `${kind}(${flow.map(shape).join(",")})` : kind;
}

const FLOW = new Set([
  "blockquote", "code", "definition", "footnoteDefinition", "heading", "list",
  "listItem", "paragraph", "table", "thematicBreak",
]);
