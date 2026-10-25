/**
 * Fenced code blocks and inline code spans in Markdown/MDX source, for the
 * passes that rewrite prose and must leave code alone. A line scanner rather
 * than a parser: it runs at request time, where the native parser isn't
 * available. It follows CommonMark for fences (backtick or tilde, a closing
 * fence at least as long as the opening one, fences in lists, on a list-item
 * line, or nested in `>` quotes); `code-regions.test.ts` checks it against the
 * parser.
 */

// The container prefix: indentation, `>` markers, and list markers (`-`, `1.`).
const FENCE_OPEN = /^((?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])[ \t]))*[ \t]*)(`{3,}|~{3,})([^\r]*)/;

export const INLINE_CODE = /`[^`\n]+`/g;

export interface FencedBlock {
  /** Line index of the opening fence. */
  open: number;
  /** Line index of the closing fence. */
  close: number;
  /** The container prefix before the opening fence: indentation, `>`, and list markers. */
  prefix: string;
}

/**
 * Closed fenced blocks in `lines`, in order. An unclosed fence is left as
 * prose, including one whose `>` quote ends before the fence closes.
 */
export function fencedBlocks(lines: readonly string[]): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]!);
    const [, prefix = "", fence = "", info = ""] = open ?? [];
    if (!open || (fence[0] === "`" && info.includes("`"))) continue;
    // A closing fence may be indented up to three spaces within its container.
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`);
    const depth = prefix.split(">").length - 1;
    let end = i + 1;
    while (
      end < lines.length &&
      quoteDepth(lines[end]!) >= depth &&
      !close.test(stripPrefix(lines[end]!, prefix))
    ) {
      end++;
    }
    if (end === lines.length || quoteDepth(lines[end]!) < depth) continue;
    blocks.push({ open: i, close: end, prefix });
    i = end;
  }
  return blocks;
}

function quoteDepth(line: string): number {
  return /^[ \t]*((?:>[ \t]*)*)/.exec(line)![1]!.split(">").length - 1;
}

/**
 * Remove the opening fence's container prefix from a line inside the block, as
 * CommonMark does for an indented fence. A list marker's width counts as
 * indentation, since the item's lines are indented under it.
 */
export function stripPrefix(line: string, prefix: string): string {
  let i = 0;
  while (
    i < prefix.length &&
    i < line.length &&
    /[ \t>]/.test(line[i]!) &&
    (line[i] === ">") === (prefix[i] === ">")
  ) {
    i++;
  }
  return line.slice(i);
}
