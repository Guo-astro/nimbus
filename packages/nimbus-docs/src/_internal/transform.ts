/**
 * MDX → Markdown transform for generated static routes.
 *
 * This intentionally starts small and dependency-free: it operates on the
 * raw MDX body that Astro's content layer exposes and maps the starter's
 * default components to plain markdown equivalents. The route that calls this
 * lives in user code, so replacing or bypassing this transformer is a one-line
 * edit.
 */

import {
  hasCitation,
  resolveCitations,
  type CitationIndex,
} from "./api/citations.js";
import { getTabs, isCommandType } from "../lib/pkgm.js";
import { fencedBlocks, INLINE_CODE, stripPrefix } from "./code-regions.js";

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

// A fence's container before its token: `>` markers and list markers.
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])[ \t]))+[ \t]*$/;
const LIST_MARKER = /(?:[-*+]|\d{1,9}[.)])(?=[ \t])/g;

function protectFences(
  markdown: string,
  store: (chunk: string) => string,
): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let next = 0;
  for (const { open, close, prefix } of fencedBlocks(lines)) {
    out.push(...lines.slice(next, open));
    const body = lines.slice(open + 1, close + 1).map((line) => stripPrefix(line, prefix));
    out.push(prefix + store([lines[open]!.slice(prefix.length), ...body].join("\n")));
    next = close + 1;
  }
  out.push(...lines.slice(next));
  return out.join("\n");
}

function protectCode(markdown: string): {
  markdown: string;
  restore: (value: string) => string;
} {
  const protectedChunks: string[] = [];
  const store = (kind: "FENCE" | "CODE") => (chunk: string) => {
    const token = `@@NIMBUS_MD_${kind}_${protectedChunks.length}@@`;
    protectedChunks.push(chunk);
    return token;
  };

  // Fenced blocks first so inline-code protection doesn't touch backticks inside.
  let next = protectFences(markdown, store("FENCE"));
  next = next.replace(INLINE_CODE, store("CODE"));

  return {
    markdown: next,
    restore(value: string): string {
      return value.replace(
        /@@NIMBUS_MD_(?:FENCE|CODE)_(\d+)@@/g,
        (_match, index: string, offset: number, whole: string) => {
          const chunk = protectedChunks[Number(index)] ?? "";
          const before = whole.slice(whole.lastIndexOf("\n", offset) + 1, offset);
          // A fence in a list item sits behind plain indentation.
          if (!CONTAINER_PREFIX.test(before) && !/^[ \t]+$/.test(before)) return chunk;
          // Later lines keep the quote markers; a list marker becomes indentation.
          const continuation = before.replace(LIST_MARKER, (marker) => " ".repeat(marker.length));
          const blank = continuation.trimEnd();
          return chunk.replace(/\n([^\n\r]*)/g, (_line, text: string) =>
            text ? `\n${continuation}${text}` : `\n${blank}`,
          );
        },
      );
    },
  };
}

function parseAttrs(raw = ""): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  const re =
    /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/g;
  for (const match of raw.matchAll(re)) {
    const [, name, dq, sq, expr, bare] = match;
    if (!name) continue;
    attrs[name] = dq ?? sq ?? expr?.trim() ?? bare ?? true;
  }
  return attrs;
}

/**
 * String-valued attributes only: quoted values and string-literal expressions
 * (`title={"Setup"}`). A title written as code (`title={t("k")}`) has no text
 * to show, so it's left out and the caller's fallback applies.
 */
function textAttrs(raw = ""): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\})/g;
  for (const match of raw.matchAll(re)) {
    const [, name, ...values] = match;
    const value = values.find((v) => v !== undefined);
    if (name && value !== undefined) attrs[name] = value;
  }
  return attrs;
}

const indentOf = (line: string): number => columns(/^[ \t]*/.exec(line)![0]);
const JSX_TAG_LINE = /^[ \t]*<\/?[A-Za-z]/;

/**
 * Where Markdown puts a line indented `indent` columns, given the lines above
 * it: the content column of the list item that holds it, or 0. MDX has no
 * indented code, so indentation outside a list item is only layout; kept, 4 or
 * more columns would read as code in Markdown. JSX tag lines are skipped: their
 * indentation is markup nesting, not Markdown structure. `lineUp(k)` is the
 * line `k` lines above, as written; `placed(k)` is the column it now starts
 * at, when those lines have been moved.
 */
function markdownColumn(
  lineUp: (k: number) => string | undefined,
  indent: number,
  isItem: boolean,
  placed: (k: number) => number = (k) => indentOf(lineUp(k)!),
): number {
  if (indent === 0) return 0;
  // Only lines less indented than `bound` can hold this one.
  let bound = indent;
  for (let k = 1, line = lineUp(k); line !== undefined; line = lineUp(++k)) {
    if (!line.trim() || indentOf(line) >= bound) continue;
    const item = LIST_ITEM.exec(line);
    if (item) {
      const shift = placed(k) - indentOf(line);
      const column = contentColumn(item);
      if (indent >= column) return shift + column;
      // Short of the item's content: a sibling item, a lazy continuation of
      // the line right above, or (after a blank line) outside the item.
      if (isItem) return shift + columns(item[1]!);
      if (k === 1) return shift + column;
      bound = indentOf(line);
      continue;
    }
    // Indented text or markup belongs to whatever holds it; keep looking.
    if (JSX_TAG_LINE.test(line) || indentOf(line) > 0) continue;
    return 0;
  }
  return 0;
}

/**
 * A component's children as Markdown lines: leading blank lines and trailing
 * whitespace dropped, and each line's indentation set by the list structure
 * around it. Stripping all indentation would move a list item's code block
 * and prose out of the item. A first line on the tag's own line is kept as is.
 */
function cleanChildren(children: string): string {
  const lines = children.replace(/\s+$/, "").split("\n");
  const first = lines[0]!.trim() ? lines.shift()!.trim() : null;
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  const columnsAt: number[] = [];
  // An HTML element's closing tag goes where its opening tag went: inside the
  // list item that holds the element, or out of a list the element wraps.
  const openTags: Array<{ name: string; column: number }> = [];
  const out = lines.map((line, index) => {
    const text = line.replace(/^[ \t]*/, "");
    const closing = /^<\/([a-z][\w-]*)\s*>/.exec(text)?.[1];
    let opener = -1;
    for (let i = openTags.length - 1; closing && i >= 0; i--) {
      if (openTags[i]!.name === closing) {
        opener = i;
        break;
      }
    }
    if (opener >= 0) {
      columnsAt[index] = openTags[opener]!.column;
      openTags.length = opener;
    } else {
      columnsAt[index] = text
        ? markdownColumn((k) => lines[index - k], indentOf(line), LIST_ITEM.test(line), (k) => columnsAt[index - k]!)
        : 0;
      const opening = /^<([a-z][\w-]*)\b[^>]*>(?!.*<\/\1\s*>)/.exec(text);
      if (opening && !opening[0].endsWith("/>")) openTags.push({ name: opening[1]!, column: columnsAt[index]! });
    }
    return text ? " ".repeat(columnsAt[index]!) + text : "";
  });
  return (first === null ? out : [first, ...out]).join("\n").trim();
}

// Leading `>` and list markers on a line, with their spacing.
const CONTAINER_START = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])[ \t]))*[ \t]*/;

/** Where a component's tag sits, and so where its output goes. */
interface TagSite {
  /** Indentation that replaces the tag's own (a tag matched at its line's start). */
  first: string;
  /** Prefix for every later output line: a list item's indentation, quote markers. */
  rest: string;
  /** Only indentation or container markers precede the tag on its line. */
  ownsLine: boolean;
  /** List or quote markers precede the tag on its line. */
  afterMarker: boolean;
  /** Only whitespace follows the tag's end on its line. */
  endsLine: boolean;
  /** The line above the tag's is blank (or there is none). */
  blankBefore: boolean;
  /** The line below the tag's end is blank, a list item, or absent. */
  openAfter: boolean;
  /** Quote markers each child line carries, removed before rendering. */
  quotes: number;
}

/** Lines above `lineStart`, read backwards on demand: `k = 1` is the line right above. */
function linesAbove(whole: string, lineStart: number): (k: number) => string | undefined {
  const read: string[] = [];
  let cursor = lineStart - 1; // the newline that ends the line above
  return (k) => {
    while (read.length < k && cursor >= 0) {
      // lastIndexOf treats a negative start as 0, which would reread line 0.
      const start = cursor === 0 ? 0 : whole.lastIndexOf("\n", cursor - 1) + 1;
      read.push(whole.slice(start, cursor));
      cursor = start - 1;
    }
    return read[k - 1];
  };
}

function tagSite(whole: string, offset: number, lead: string | undefined, length: number): TagSite {
  const lineStart = whole.lastIndexOf("\n", offset - 1) + 1;
  const above = linesAbove(whole, lineStart);
  const lineEnd = whole.indexOf("\n", offset + length);
  const nextEnd = lineEnd === -1 ? -1 : whole.indexOf("\n", lineEnd + 1);
  const after = lineEnd === -1 ? "" : whole.slice(lineEnd + 1, nextEnd === -1 ? undefined : nextEnd);
  const site = {
    endsLine: /^[ \t]*$/.test(whole.slice(offset + length, lineEnd === -1 ? undefined : lineEnd)),
    blankBefore: !above(1)?.trim(),
    openAfter: !after.trim() || LIST_ITEM.test(after),
  };
  const placed = (prefix: string) => ({ ...site, quotes: (prefix.match(/>/g) ?? []).length });
  if (lead !== undefined) {
    const indent = " ".repeat(markdownColumn(above, columns(lead), false));
    return { ...placed(""), first: indent, rest: indent, ownsLine: true, afterMarker: false };
  }
  const before = whole.slice(lineStart, offset);
  const container = CONTAINER_START.exec(before)![0];
  const ownsLine = container === before;
  const rest = /\S/.test(container)
    ? container.replace(LIST_MARKER, (marker) => " ".repeat(marker.length))
    : " ".repeat(markdownColumn(above, columns(container), false));
  return { ...placed(rest), first: "", rest, ownsLine, afterMarker: ownsLine && /\S/.test(before) };
}

/** Remove the quote markers a child line carries from its enclosing blockquote. */
function unquote(children: string, quotes: number): string {
  if (quotes === 0) return children;
  const marker = new RegExp(`^[ \\t]*(?:>[ \\t]?){1,${quotes}}`);
  return children.replace(/[^\n]+/g, (line) => line.replace(marker, ""));
}

/**
 * Place a component's output at its tag's site. A block (a callout, a list of
 * steps) gets its own lines: blank lines around it when its neighbours would
 * otherwise run into it, and a fresh line when text precedes the tag.
 */
function place(output: string, site: TagSite, block: boolean): string {
  const blank = site.rest.trimEnd();
  const indentLines = (text: string) =>
    text.replace(/\n([^\n]*)/g, (_line, line: string) => `\n${line ? site.rest + line : blank}`);
  if (block && !site.ownsLine) return `\n${blank}\n${site.rest}${indentLines(output)}\n${blank}\n${site.rest}`;
  const lead = block && !site.afterMarker && !site.blankBefore ? `${blank}\n` : "";
  const tail = block && site.endsLine && !site.openAfter ? `\n${blank}` : "";
  return `${lead}${site.first}${indentLines(output)}${tail}`;
}

/**
 * Replace every match of `tag` (a component's opening-to-closing pattern) with
 * `render`'s output placed at the tag's site. The optional leading group lets
 * a tag that starts its line replace its own indentation.
 */
function replaceComponent(
  markdown: string,
  tag: RegExp,
  block: boolean | ((site: TagSite) => boolean),
  render: (groups: string[], site: TagSite) => string | null,
): string {
  // The leading group shifts `tag`'s backreferences by one.
  const source = tag.source.replace(/\\(\d)/g, (_ref, n: string) => `\\${Number(n) + 1}`);
  const re = new RegExp(`(^[ \\t]+)?(?:${source})`, "gm");
  return markdown.replace(re, (...args: unknown[]) => {
    const match = args[0] as string;
    const whole = args[args.length - 1] as string;
    const offset = args[args.length - 2] as number;
    const lead = args[1] as string | undefined;
    const site = tagSite(whole, lead === undefined ? offset : offset + lead.length, lead, match.length - (lead?.length ?? 0));
    const groups = (args.slice(2, -2) as Array<string | undefined>).map((group) =>
      group === undefined ? "" : unquote(group, site.quotes),
    );
    const output = render(groups, site);
    if (output === null) return match;
    return place(output, site, typeof block === "function" ? block(site) : block);
  });
}

function blockquote(body: string): string {
  return body
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function asTitle(
  value: string | boolean | undefined,
  fallback: string,
): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function renderPackageManagers(
  attrs: Record<string, string | boolean>,
): string {
  const asString = (value: string | boolean | undefined) =>
    typeof value === "string" ? value : undefined;
  const type = asString(attrs.type) ?? "add";
  if (!isCommandType(type)) return "";
  const comment = asString(attrs.comment);
  const commands = getTabs(
    type,
    asString(attrs.pkg),
    { args: asString(attrs.args), dev: attrs.dev === true || attrs.dev === "true" },
  ).map((tab) => tab.cmd);
  if (commands.length === 0) return "";
  return [
    "```sh",
    ...(comment ? [`# ${comment}`] : []),
    ...commands,
    "```",
  ].join("\n");
}

/**
 * `<Name …>…</Name>` with no `<Name` inside: the innermost of nested
 * same-name components, so each closing tag pairs with its own opening tag.
 * Callers repeat until none are left, working outwards.
 */
function innermost(name: string, attrs = "([^>]*)"): RegExp {
  return new RegExp(`<${name}\\b${attrs}>((?:(?!<${name}\\b)[\\s\\S])*?)<\\/${name}>`);
}

function replaceNested(
  markdown: string,
  tag: RegExp,
  block: boolean,
  render: Parameters<typeof replaceComponent>[3],
): string {
  let out = markdown;
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = replaceComponent(out, tag, block, render);
  }
  return out;
}

function applyDefaultComponentTransforms(markdown: string): string {
  let out = markdown;

  out = replaceComponent(out, /<PackageManagers\b([^>]*)\/>/, false, ([rawAttrs]) =>
    renderPackageManagers(parseAttrs(rawAttrs)),
  );

  out = replaceNested(out, innermost("Aside"), true, ([rawAttrs, children]) => {
    const attrs = parseAttrs(rawAttrs);
    const type = asTitle(attrs.type, "note").toUpperCase();
    const title = asTitle(textAttrs(rawAttrs).title, type.charAt(0) + type.slice(1).toLowerCase());
    return blockquote(`**${title}**\n\n${cleanChildren(children!)}`);
  });

  // Cards are list items: consecutive cards stay one tight list.
  out = replaceNested(out, innermost("Card"), false, ([rawAttrs, children]) => {
    const title = asTitle(textAttrs(rawAttrs).title, "Card");
    const body = cleanChildren(children!);
    if (!body) return `- **${title}**`;
    // A one-line body follows the title; anything more (a list, paragraphs)
    // goes below it, inside the item.
    if (!body.includes("\n") && !LIST_ITEM.test(body)) return `- **${title}** — ${body}`;
    return `- **${title}**\n\n  ${body.replace(/\n(?=[^\n])/g, "\n  ")}`;
  });
  out = out.replace(/<\/?CardGrid\b[^>]*>/g, "");

  out = replaceComponent(out, /<LinkCard\b([^>]*?)\s*\/>/, false, ([rawAttrs]) => {
    const attrs = textAttrs(rawAttrs);
    const title = asTitle(attrs.title, "Link");
    const label = attrs.href ? `[${title}](${attrs.href})` : `**${title}**`;
    return `- ${label}${attrs.description ? ` — ${attrs.description}` : ""}`;
  });

  out = replaceNested(out, innermost("Steps", "[^>]*"), true, ([children]) => {
    let index = 0;
    return cleanChildren(children!).replace(
      /<Step\b([^>]*)>([\s\S]*?)<\/Step>/g,
      (_stepMatch, rawAttrs: string, stepChildren: string, offset: number, whole: string) => {
        index += 1;
        const newLine = offset > 0 && whole[offset - 1] !== "\n" ? "\n" : "";
        const marker = `${index}. `;
        const title = asTitle(textAttrs(rawAttrs).title, `Step ${index}`);
        const body = cleanChildren(stepChildren).replace(/\n(?=[^\n])/g, `\n${" ".repeat(marker.length)}`);
        return `${newLine}${marker}**${title}**${body ? `\n\n${" ".repeat(marker.length)}${body}` : ""}`;
      },
    );
  });

  out = replaceNested(out, innermost("Tabs", "[^>]*"), true, ([children]) =>
    cleanChildren(children!).replace(
      /<TabItem\b([^>]*)>([\s\S]*?)<\/TabItem>/g,
      (_tabMatch, rawAttrs: string, tabChildren: string, offset: number, whole: string) => {
        const label = asTitle(textAttrs(rawAttrs).label, "Option");
        const body = cleanChildren(tabChildren);
        const newBlock = offset > 0 && whole[offset - 1] !== "\n" ? "\n\n" : "";
        return `${newBlock}### ${label}${body ? `\n\n${body}` : ""}`;
      },
    ),
  );

  // Components without a renderer keep their children rather than leaking JSX
  // into the markdown. Repeat until none are left: unwrapping `<AccordionGroup>`
  // exposes its `<Accordion>` tags. One on a line of its own is a block, so
  // consecutive ones (`<AccordionTrigger>`, `<AccordionContent>`) don't run into
  // one paragraph. Attributes are dropped: a `title` is often only a tooltip.
  const wrapper = /<([A-Z][A-Za-z0-9]*)\b[^>]*>([\s\S]*?)<\/\1>/;
  const isBlock = (site: TagSite) => site.ownsLine && site.endsLine;
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = replaceComponent(out, wrapper, isBlock, ([, children]) => cleanChildren(children!));
  }
  out = out.replace(/<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g, "");

  return out;
}

function applyCustomComponentTransforms(
  markdown: string,
  componentMap: Record<string, MarkdownComponentRenderer>,
  base: string,
): string {
  let out = markdown;
  for (const [name, render] of Object.entries(componentMap)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = replaceComponent(
      out,
      new RegExp(`<${escapedName}(?=[\\s/>])([^>]*)>([\\s\\S]*?)<\\/${escapedName}>`),
      false,
      ([rawAttrs, children]) =>
        render({ name, attrs: parseAttrs(rawAttrs), children: cleanChildren(children!), base }),
    );
    out = replaceComponent(
      out,
      new RegExp(`<${escapedName}(?=[\\s/>])([^>]*)\\/>`),
      false,
      ([rawAttrs]) => render({ name, attrs: parseAttrs(rawAttrs), children: "", base }),
    );
  }
  return out;
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
  if (isMdx && /<Render(?=[\s/>])/.test(protectCode(markdown).markdown)) {
    throw new Error(
      "nimbus-docs: renderEntryAsMarkdown no longer expands <Render> partials at runtime. " +
        "Serve it with getMarkdownPayload from @cloudflare/nimbus-docs/agent-endpoints.",
    );
  }

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

  const protectedCode = protectCode(markdown);
  markdown = protectedCode.markdown;

  if (options.componentMap) {
    markdown = applyCustomComponentTransforms(
      markdown,
      options.componentMap,
      options.base ?? "/",
    );
  }
  markdown = applyDefaultComponentTransforms(markdown);

  // Normalize layout before restoring code so code blocks stay byte-identical.
  markdown = markdown
    .replace(/^[ \t]+$/gm, "")
    .replace(/^([ \t]*(?:>[ \t]*)+)\n(?:\1\n)+/gm, "$1\n");
  markdown = dedentComponentFences(markdown)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return protectedCode.restore(markdown);
}

const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/;

/** Width of leading whitespace, with tabs expanded to the next multiple of 4. */
function columns(whitespace: string): number {
  let width = 0;
  for (const char of whitespace) width = char === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
}

/** The column a list item's content starts at, per CommonMark. */
function contentColumn(item: RegExpExecArray): number {
  const markerEnd = columns(item[1]!) + item[2]!.length;
  const gap = columns(item[1]! + " ".repeat(item[2]!.length) + item[3]!) - markerEnd;
  return gap > 4 ? markerEnd + 1 : markerEnd + gap;
}

/**
 * Place each fence where the Markdown reader expects it. A fence inside a
 * list item moves to the item's content column: at column 0 it would end the
 * list, and 4 or more columns past it the backticks would read as indented
 * code. Any other fence is indented only by component markup (`<Tabs>`,
 * `<Steps>`) and moves to column 0.
 */
function dedentComponentFences(markdown: string): string {
  const lines = markdown.split("\n");
  return lines
    .map((line, index) => {
      const fence = /^([ \t]+)(```|@@NIMBUS_MD_FENCE_)/.exec(line);
      if (!fence) return line;
      const indent = columns(fence[1]!);
      for (let i = index - 1; i >= 0; i--) {
        const previous = lines[i]!;
        if (!previous.trim()) continue;
        if (columns(/^[ \t]*/.exec(previous)![0]) >= indent) continue;
        const item = LIST_ITEM.exec(previous);
        const column = item ? contentColumn(item) : -1;
        return column >= 0 && column <= indent ? " ".repeat(column) + line.trimStart() : line.trimStart();
      }
      return line.trimStart();
    })
    .join("\n");
}
