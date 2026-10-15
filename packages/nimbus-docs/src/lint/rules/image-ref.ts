/**
 * nimbus/image-ref — image references that don't resolve to a file on
 * disk. Unlike `internal-link` (whose truth is the emergent route set,
 * materialized at build time), image truth is just the filesystem: a
 * site-absolute ref maps to `public/`, a relative ref to the authoring
 * file's directory. No build prerequisite, no silent-skip machinery.
 *
 * Coverage:
 *   - `image` nodes (`![alt](url)`)
 *   - `imageReference` nodes (`![alt][ref]` resolved against `definition`s)
 *   - MDX JSX `<img src="...">`
 *   - Extra JSX components opt-in via `components: [{ name, attr }, …]` —
 *     same shape as `internal-link`'s option, same rationale: component
 *     names belong to the user.
 *
 * Resolution:
 *   - `/foo.png` → `<root>/public/foo.png` (Astro serves `public/` at the
 *     site root).
 *   - Under a deployment base (`ctx.base`, e.g. `/docs`), Astro serves
 *     `public/` only under the base and leaves inline image paths as written,
 *     while Nimbus adds the base to reference definitions. So an inline image
 *     or `<img src>` needs the base written (`/docs/foo.png`) and a definition
 *     must not repeat it; the rule reports both, with a fix for inline images
 *     and definitions when the file exists in `public/`. Component attributes
 *     accept either form (a component may add the base itself).
 *   - `./shot.png` / `../img.png` → relative to the MDX file (Astro's image
 *     pipeline resolves these as imports — they're valid and checkable).
 *   - `aliases: { "~/assets/": "src/assets/" }` maps prefix → root-relative
 *     directory. The framework ships none by default — `~/` is a per-project
 *     tsconfig path, not a framework concept.
 *   - External URLs (any scheme, incl. `data:`, and `//`) are skipped —
 *     remote existence checks are a network concern, not a lint.
 *   - Dynamic JSX attrs (`<img src={x}>`) are skipped — not checkable.
 *   - `ignore: string[]` supports full glob syntax (`**`, `*`, `{a,b}`, …)
 *     via `../../_internal/ignore-glob.js` (picomatch-backed), matched
 *     against the cleaned URL (query/hash stripped, percent-decoded) and,
 *     like `internal-link`'s option, without the site base.
 *
 * A miss whose containing directory exists produces a "did you mean" hint
 * from that directory's entries via Levenshtein distance.
 */

import fs from "node:fs";
import path from "node:path";

import { destinationOffset } from "../../_internal/authored-links.js";
import { matchesAnyIgnore } from "../../_internal/ignore-glob.js";
import { suggest } from "../../_internal/levenshtein.js";
import { collect, startOf, visit, type MdNode } from "../parse.js";
import type { DiagnosticFix } from "../diagnostic.js";
import type { Rule } from "../rule.js";

export const imageRef: Rule = {
  code: "nimbus/image-ref",
  run(ctx) {
    const root = ctx.file.projectRoot ?? inferProjectRoot(ctx.file.absPath);
    const aliases = readAliases(ctx.options.aliases);
    // Pass through raw, unfiltered — `matchesAnyIgnore` caches its
    // compiled matcher on this array's identity. Filtering here would
    // break that cache (new array per file).
    const ignore = ctx.options.ignore;
    const extraComponents = readExtraComponents(ctx.options.components);
    const base = ctx.base ?? "";
    // URLs are compared decoded (`cleanUrl`), so the base is too; messages and
    // edits keep the base as written.
    const decodedBase = cleanUrl(base);

    for (const occ of collectImageOccurrences(ctx.file.tree, extraComponents)) {
      const url = occ.url;
      if (!url) continue;
      if (isExternal(url)) continue;

      const cleaned = cleanUrl(url);
      if (cleaned === "") continue;

      const aliased = aliases.some(([prefix]) => cleaned.startsWith(prefix));
      const underBase = base !== "" && !aliased && cleaned.startsWith("/");
      const based = underBase && (cleaned === decodedBase || cleaned.startsWith(`${decodedBase}/`));
      const unbased = based ? cleaned.slice(decodedBase.length) || "/" : cleaned;
      // Patterns are written without the base, as for links; one written with it still matches.
      if (matchesAnyIgnore(unbased, ignore) || (based && matchesAnyIgnore(cleaned, ignore))) continue;

      const at = startOf(occ.node);
      const report = (message: string, fix?: DiagnosticFix) =>
        ctx.report({ message, line: at.line, column: at.column, ...(fix ? { fix } : {}) });

      if (!underBase) {
        const resolved = resolveToDisk(cleaned, root, ctx.file.absPath, aliases);
        if (resolved === null) continue; // unrecognised shape — silence beats false-positive
        if (!fileExists(resolved.fullPath)) report(missing(url, resolved));
        continue;
      }

      if (occ.kind === "component") {
        const resolved = inPublic(root, unbased);
        if (!fileExists(resolved.fullPath)) report(missing(url, resolved));
        continue;
      }

      if (occ.kind === "definition") {
        // Nimbus adds the base when rendering, so the definition is served
        // from `public/` exactly as written.
        const served = inPublic(root, cleaned);
        if (fileExists(served.fullPath)) continue;
        if (!based) {
          report(missing(url, served));
          continue;
        }
        const intended = inPublic(root, unbased);
        if (!fileExists(intended.fullPath)) {
          report(missing(url, served, ` Nimbus adds the site base "${base}" to definitions, so write it without the base.`));
          continue;
        }
        // An encoded base (`/%64ocs/…`) can't be sliced off the URL as written.
        const written = url.startsWith(`${base}/`) ? url.slice(base.length) : undefined;
        report(
          `definition "${url}" repeats the site base "${base}"; Nimbus adds it, so it renders as "${base}${url}". ` +
            (written ? `Write "${written}".` : "Write it without the base."),
          written ? definitionFix(ctx.file.source, occ.node, base, written) : undefined,
        );
        continue;
      }

      const intended = inPublic(root, unbased);
      if (based) {
        if (!fileExists(intended.fullPath)) report(missing(url, intended));
        continue;
      }
      const written = `${base}${url}`;
      if (!fileExists(intended.fullPath)) {
        report(missing(url, intended, ` Under the site base "${base}", write "${written}" once it exists.`));
        continue;
      }
      report(
        `image "${url}" skips the site base "${base}" and won't load. Write "${written}".`,
        occ.kind === "image" ? imageFix(ctx.file.source, occ.node, base, written) : undefined,
      );
    }
  },
};

function missing(url: string, resolved: ResolvedRef, note = ""): string {
  const hint = suggestSibling(resolved.fullPath);
  return hint
    ? `missing image "${url}" — expected at ${resolved.display}; did you mean "${hint}"?${note}`
    : `missing image "${url}" — expected at ${resolved.display}.${note}`;
}

function inPublic(root: string, url: string): ResolvedRef {
  const rel = path.join("public", url.slice(1));
  return { fullPath: path.join(root, rel), display: rel };
}

// ---------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------

/**
 * Insert the base before an inline image's destination. Only when the
 * node's source has exactly one `](` (so alt text can't hold a look-alike)
 * and the URL follows it exactly as parsed: an escaped or encoded
 * destination gets no fix.
 */
function imageFix(
  source: string,
  node: MdNode,
  base: string,
  written: string,
): DiagnosticFix | undefined {
  const range = offsets(node);
  if (!range) return undefined;
  const raw = source.slice(range[0], range[1]);
  const opening = raw.indexOf("](");
  if (opening === -1 || raw.indexOf("](", opening + 1) !== -1) return undefined;
  let at = opening + 2;
  while (/\s/.test(raw[at] ?? "")) at += 1;
  if (raw[at] === "<") at += 1;
  const url = typeof node.url === "string" ? node.url : "";
  if (!raw.startsWith(url, at) || !/^[\s>)]/.test(raw.slice(at + url.length))) return undefined;
  const offset = range[0] + at;
  return {
    description: `Write "${written}"`,
    edits: [{ range: [offset, offset], text: base }],
  };
}

/** Remove the base from a definition's destination when the source spells it literally. */
function definitionFix(
  source: string,
  node: MdNode,
  base: string,
  written: string,
): DiagnosticFix | undefined {
  let offset: number;
  try {
    offset = destinationOffset(source, node, undefined);
  } catch {
    return undefined;
  }
  const next = source[offset + base.length];
  if (!source.startsWith(base, offset) || (next !== "/" && next !== undefined && !/[\s>]/.test(next))) {
    return undefined;
  }
  return {
    description: `Write "${written}"`,
    edits: [{ range: [offset, offset + base.length], text: "" }],
  };
}

function offsets(node: MdNode): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? [start, end] : null;
}

// ---------------------------------------------------------------------------
// AST traversal
// ---------------------------------------------------------------------------

interface ImageOccurrence {
  /** `definition` stands for every `imageReference` that resolves to it, reported once. */
  kind: "image" | "img" | "definition" | "component";
  url: string;
  /** Where the finding is reported (and fixed). */
  node: MdNode;
}

interface ComponentSpec {
  name: string;
  attr: string;
}

/**
 * `<img src>` is always checked — a plain img means the same thing in
 * every MDX file. Extra components come from the `components` option.
 */
function readExtraComponents(value: unknown): ComponentSpec[] {
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

function collectImageOccurrences(
  root: MdNode,
  extraComponents: ComponentSpec[],
): ImageOccurrence[] {
  const definitions = collectDefinitions(root);
  const reported = new Set<MdNode>();
  const out: ImageOccurrence[] = [];
  visit(root, (node) => {
    if (node.type === "image") {
      out.push({ kind: "image", url: typeof node.url === "string" ? node.url : "", node });
      return;
    }
    if (node.type === "imageReference") {
      const identifier =
        typeof node.identifier === "string" ? node.identifier : "";
      const definition = definitions.get(identifier);
      if (!definition || reported.has(definition)) return;
      reported.add(definition);
      out.push({ kind: "definition", url: definition.url as string, node: definition });
      return;
    }
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      if (node.name === "img") {
        const src = readJsxStringAttr(node, "src");
        if (src === null) return;
        out.push({ kind: "img", url: src, node });
        return;
      }
      for (const spec of extraComponents) {
        if (node.name !== spec.name) continue;
        const src = readJsxStringAttr(node, spec.attr);
        if (src === null) return;
        out.push({ kind: "component", url: src, node });
        return;
      }
    }
  });
  return out;
}

/** First definition per identifier wins, as CommonMark resolves them. */
function collectDefinitions(root: MdNode): Map<string, MdNode> {
  const out = new Map<string, MdNode>();
  for (const def of collect(root, "definition")) {
    const id = typeof def.identifier === "string" ? def.identifier : "";
    const url = typeof def.url === "string" ? def.url : "";
    if (id && url && !out.has(id)) out.set(id, def);
  }
  return out;
}

/**
 * Read a string-valued JSX attribute. Returns null when the attribute is
 * absent, dynamic (expression form `<img src={x}>`), or boolean.
 * Static-only on purpose — dynamic srcs aren't checkable.
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

// ---------------------------------------------------------------------------
// URL classification + resolution
// ---------------------------------------------------------------------------

function isExternal(url: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) || // any scheme: http:, data:, …
    url.startsWith("//") // protocol-relative
  );
}

/** Strip query string and hash, then percent-decode. */
function cleanUrl(url: string): string {
  let s = url;
  const q = s.indexOf("?");
  if (q !== -1) s = s.slice(0, q);
  const h = s.indexOf("#");
  if (h !== -1) s = s.slice(0, h);
  try {
    s = decodeURI(s);
  } catch {
    // Malformed encoding — leave as-is; the disk lookup will (correctly)
    // fail and surface a diagnostic the author can fix.
  }
  return s;
}

function readAliases(value: unknown): Array<[prefix: string, dir: string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: Array<[string, string]> = [];
  for (const [prefix, dir] of Object.entries(value as Record<string, unknown>)) {
    if (typeof dir === "string" && prefix.length > 0) out.push([prefix, dir]);
  }
  // Longest prefix wins when aliases nest (`~/assets/icons/` over `~/assets/`).
  out.sort((a, b) => b[0].length - a[0].length);
  return out;
}

interface ResolvedRef {
  fullPath: string;
  /** Root-relative form for the diagnostic message. */
  display: string;
}

function resolveToDisk(
  url: string,
  root: string,
  fileAbsPath: string,
  aliases: Array<[string, string]>,
): ResolvedRef | null {
  for (const [prefix, dir] of aliases) {
    if (url.startsWith(prefix)) {
      const rel = path.join(dir, url.slice(prefix.length));
      return { fullPath: path.join(root, rel), display: rel };
    }
  }
  if (url.startsWith("/")) {
    const rel = path.join("public", url.slice(1));
    return { fullPath: path.join(root, rel), display: rel };
  }
  if (url.startsWith("./") || url.startsWith("../")) {
    const fullPath = path.resolve(path.dirname(fileAbsPath), url);
    const rel = path.relative(root, fullPath);
    return { fullPath, display: rel.startsWith("..") ? fullPath : rel };
  }
  return null;
}

function fileExists(fullPath: string): boolean {
  try {
    return fs.statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Did-you-mean from the missing file's own directory — cheap (one
 * `readdir`) and covers the dominant failure (typo or wrong extension in
 * the filename, not the directory).
 */
function suggestSibling(fullPath: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.dirname(fullPath));
  } catch {
    return null;
  }
  return suggest(path.basename(fullPath), new Set(entries), 3);
}

/** Find the project root from a content file by walking up to the parent of `src`. */
function inferProjectRoot(absPath: string): string {
  const norm = absPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/src/");
  return idx === -1 ? path.dirname(absPath) : norm.slice(0, idx);
}
