/**
 * Relative images in a page's Markdown version.
 *
 * `![x](./pipeline.png)` works in the HTML page because Astro resolves it
 * against the source file. The Markdown version keeps the author's bytes, so
 * the same path resolves against the `.md` URL (or `/llms-full.txt`) and 404s.
 * Rendering rewrites each relative image to a stable URL under
 * {@link MARKDOWN_IMAGE_PREFIX} and records the source file; the build copies
 * every recorded file to that URL. Renders run in the build's own process
 * (prerendered `.md` routes and the prepared agent pipeline), so the record is
 * shared through `globalThis`. No Node imports: this module is bundled into
 * server builds with the renderer.
 */
export const MARKDOWN_IMAGE_PREFIX = "_nimbus/md";

const REGISTRY = Symbol.for("nimbus-docs.markdown-images");

type Registry = Map<string, string>; // output path (under the prefix) → project-relative source

/** Every image recorded since the last build, by output path. */
export function markdownImageRegistry(): Registry {
  const store = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (store[REGISTRY] ??= new Map());
}

interface Positioned {
  type: string;
  url?: string;
  identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Positioned[];
}

const ABSOLUTE = /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i;

/** FNV-1a, so the same source always gets the same folder. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** The project-relative source of a relative image, or undefined when it isn't one. */
function sourceOf(url: string, filePath: string): string | undefined {
  if (!url || ABSOLUTE.test(url)) return undefined;
  let clean = url.replace(/[?#].*$/, "");
  try {
    clean = decodeURI(clean);
  } catch {
    // Keep a malformed escape as written.
  }
  const parts: string[] = [];
  for (const part of [...filePath.replace(/\\/g, "/").split("/").slice(0, -1), ...clean.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined; // outside the project
      parts.pop();
    } else parts.push(part);
  }
  // An absolute source path (a content source outside the project) stays absolute.
  return parts.length > 0 ? `${filePath.startsWith("/") ? "/" : ""}${parts.join("/")}` : undefined;
}

function walk(node: Positioned, visit: (node: Positioned) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * Rewrite the relative images in `markdown`, parsed as `tree`, to their
 * published URLs, and record each source for the build to copy. Links,
 * absolute URLs and images inside code are left alone.
 */
export function rewriteRelativeImages(markdown: string, tree: Positioned, filePath: string | undefined, base: string): string {
  if (!filePath) return markdown;
  const imageRefs = new Set<string>();
  walk(tree, (node) => {
    if (node.type === "imageReference" && node.identifier) imageRefs.add(node.identifier.toLowerCase());
  });
  const edits: { at: number; length: number; url: string }[] = [];
  walk(tree, (node) => {
    const isImage = node.type === "image";
    const isImageDefinition = node.type === "definition" && imageRefs.has((node.identifier ?? "").toLowerCase());
    if (!isImage && !isImageDefinition) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || !node.url) return;
    const source = sourceOf(node.url, filePath);
    if (!source) return;
    const text = markdown.slice(start, end);
    const after = text.indexOf(isImage ? "](" : "]:");
    const at = after < 0 ? -1 : text.indexOf(node.url, after);
    if (at < 0) return;
    const output = `${MARKDOWN_IMAGE_PREFIX}/${hash(source)}/${source.slice(source.lastIndexOf("/") + 1)}`;
    markdownImageRegistry().set(output, source);
    edits.push({ at: start + at, length: node.url.length, url: `${base.replace(/\/?$/, "/")}${output}` });
  });
  let out = markdown;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, edit.at) + edit.url + out.slice(edit.at + edit.length);
  }
  return out;
}
