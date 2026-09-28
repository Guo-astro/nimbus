/**
 * Fenced code blocks and inline code spans in Markdown/MDX source, for the
 * passes that rewrite prose and must leave code alone. A line scanner rather
 * than a parser: it runs at request time, where the native parser isn't
 * available. It follows CommonMark for fences (backtick or tilde, a closing
 * fence at least as long as the opening one, fences indented in lists or
 * nested in `>` quotes); `code-regions.test.ts` checks it against the parser.
 */

const FENCE_OPEN = /^([ \t]*(?:>[ \t]?)*)(`{3,}|~{3,})([^\r]*)/;

export const INLINE_CODE = /`[^`\n]+`/g;

export interface FencedBlock {
  /** Line index of the opening fence. */
  open: number;
  /** Line index of the closing fence. */
  close: number;
  /** The container prefix before the opening fence: indentation and `>` markers. */
  prefix: string;
}

/** Closed fenced blocks in `lines`, in order. An unclosed fence is left as prose. */
export function fencedBlocks(lines: readonly string[]): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]!);
    const [, prefix = "", fence = "", info = ""] = open ?? [];
    if (!open || (fence[0] === "`" && info.includes("`"))) continue;
    const close = new RegExp(`^${fence[0]}{${fence.length},}[ \\t]*\\r?$`);
    let end = i + 1;
    while (end < lines.length && !close.test(stripPrefix(lines[end]!, prefix))) end++;
    if (end === lines.length) continue;
    blocks.push({ open: i, close: end, prefix });
    i = end;
  }
  return blocks;
}

/**
 * Remove the opening fence's container prefix (indentation, `>` markers) from
 * a line inside the block, as CommonMark does for an indented fence.
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
