/**
 * Extract registered collection names from the user's `src/content.config.ts`.
 *
 * Used by `getIndexedEntries()` and the agent-facing routes (`llms.txt`,
 * per-page `.md` alternates) so they don't have to hardcode `"docs"`.
 * Adding a new collection to `content.config.ts` lights up every
 * indexing surface automatically.
 *
 * Strategy: read the file as text and locate the `export const collections =
 * { ... }` declaration, parse its top-level keys. Same approach used by
 * `parse-components-registry.ts` — we never execute user code at build
 * time.
 *
 * Supported entry shapes inside the object literal:
 *   - shorthand:    `docs,`                         → "docs"
 *   - aliased:      `docs: defineCollection(...),`  → "docs" (the key)
 *   - string key:   `"docs": defineCollection(...)` → "docs"
 *
 * Skipped:
 *   - spread elements (`...other`)
 *   - computed keys (`[expr]: value`)
 *
 * The result is *not* filtered against reserved names here — that's
 * `getIndexedEntries()`'s job, so consumers that want the raw list (e.g.
 * tooling) can still see it.
 *
 * Returns:
 *   - the statically known names and whether every registration was resolved
 *     when the file exists and the pattern matches.
 *   - an incomplete empty result when the file exists but doesn't expose a
 *     parseable object-literal registration.
 *   - `null` when the file is missing. Callers decide whether to warn or fall
 *     back to `["docs"]`.
 */

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  findMatchingBrace,
  splitTopLevelCommas,
  stripComments,
  stripStrings,
} from "./parse-object-literal.js";

// Locate the start of the `export const collections = {` declaration; the
// matching close brace is found by walking braces.
const EXPORT_PREFIX_PATTERN =
  /export\s+const\s+collections\s*(?::\s*[^=]+)?=\s*\{/;

// A statically identifiable collection key: `docs`, `docs-v1`, `docs-v1.2`,
// `_partials`. See `parseContentCollections` for the rationale.
const COLLECTION_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export interface ParsedContentCollections {
  names: string[];
  complete: boolean;
}

export async function parseContentCollections(
  filePath: string,
): Promise<ParsedContentCollections | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const stripped = stripComments(source);
  const prefixMatch = stripped.match(EXPORT_PREFIX_PATTERN);
  if (!prefixMatch || prefixMatch.index === undefined) {
    return { names: [], complete: false };
  }
  const objectStart = prefixMatch.index + prefixMatch[0].length;
  const objectEnd = findMatchingBrace(stripped, objectStart - 1);
  if (objectEnd === -1) return { names: [], complete: false };
  const body = stripped.slice(objectStart, objectEnd);

  const names: string[] = [];
  let complete = true;
  for (const raw of splitTopLevelCommas(body)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("...") || entry.startsWith("[")) {
      complete = false;
      continue;
    }

    const colonIdx = entry.indexOf(":");
    const rawKey = colonIdx === -1 ? entry : entry.slice(0, colonIdx);
    const key = rawKey.trim().replace(/^['"`]|['"`]$/g, "");

    // Collection names are conventionally lowercase identifiers
    // (`docs`, `blog`, `api`), but Astro accepts any non-empty string as a
    // collection ID and the versioning convention (`docs-v1`, `docs-2025-q1`)
    // relies on hyphens and, for dotted versions (`docs-v1.2`), dots.
    // Accept letters/digits/underscores/hyphens/dots after a leading letter
    // or underscore (the `_*` underscore convention for hidden-from-indexing
    // collections stays intact).
    if (COLLECTION_KEY.test(key)) names.push(key);
    else complete = false;
  }

  const remainder = stripped.slice(objectEnd + 1);
  if (
    /\bcollections\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=/.test(
      remainder,
    ) ||
    /\bdelete\s+collections\s*(?:\.|\[)/.test(remainder) ||
    /\b(?:Object\.(?:assign|definePropert(?:y|ies))|Reflect\.set)\s*\(\s*collections\b/.test(
      remainder,
    )
  ) {
    complete = false;
  }

  return { names, complete };
}

/**
 * Sibling of `parseContentCollections` that also extracts each entry's
 * `base` option — the folder name under `src/content/` the collection
 * loads from. Returns a `Map<key, folderName>` where the folder defaults
 * to the collection key when no `base:` override is present.
 *
 * Used by the `nimbus/duplicate-slug` validator and any other framework
 * code that needs to walk a collection's actual on-disk location rather
 * than assuming the folder name matches the collection key. Astro's
 * content layer respects the `base` option — `docsCollection({ base:
 * "documentation" })` loads from `src/content/documentation/` while still
 * registering as collection `docs`. Without this map, filesystem-walking
 * code would mis-tag those entries (`collection: "documentation"`) and
 * either flag bogus collisions or silently skip them via the indexable-
 * collections filter.
 *
 * Extraction is regex-based — for each entry's value text, looks for
 * `\bbase:\s*["']([^"']+)["']`. That covers the documented Nimbus pattern
 * (`docsCollection({ base: "..." })`, `partialsCollection({ base: "..." })`,
 * `componentsCollection({ base: "..." })`). Limitations:
 *
 *   - Computed/dynamic bases (`base: someVar`) fall back to the collection
 *     key. A future regression would silently miscount; for now,
 *     accepted as a known v1 limitation.
 *   - Hand-rolled `defineCollection({ loader: glob({ base: "./src/content/x" }) })`
 *     puts a *path* in `base`, not a folder name. The extracted value
 *     starts with `./src/content/` and won't match a folder under
 *     `src/content/` directly. Users who write the loader by hand can
 *     keep folder names matching collection keys, or accept that
 *     `duplicate-slug` won't see their non-conforming collection until
 *     they migrate to the Nimbus helpers.
 *
 * Returns `null` when the file is missing or unparseable, matching
 * `parseContentCollections`'s contract.
 */
export async function parseCollectionBases(
  filePath: string,
): Promise<Map<string, string> | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const stripped = stripComments(source);
  const prefixMatch = stripped.match(EXPORT_PREFIX_PATTERN);
  if (!prefixMatch || prefixMatch.index === undefined) return null;
  const objectStart = prefixMatch.index + prefixMatch[0].length;
  const objectEnd = findMatchingBrace(stripped, objectStart - 1);
  if (objectEnd === -1) return null;
  const body = stripped.slice(objectStart, objectEnd);

  const out = new Map<string, string>();
  for (const raw of splitTopLevelCommas(body)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("...")) continue;
    if (entry.startsWith("[")) continue;

    const colonIdx = entry.indexOf(":");
    const rawKey = colonIdx === -1 ? entry : entry.slice(0, colonIdx);
    const key = rawKey.trim().replace(/^['"`]|['"`]$/g, "");
    if (!COLLECTION_KEY.test(key)) continue;

    // Default the folder to the key name. Override if a literal `base:`
    // appears in the entry's value — or, for shorthand entries (`{ docs }`),
    // in the local `const|let|var docs = …` declaration the shorthand
    // refers to.
    const valueText =
      colonIdx === -1
        ? findLocalDeclarationValue(stripped, key)
        : entry.slice(colonIdx + 1);
    const baseMatch = valueText.match(/\bbase\s*:\s*["']([^"']+)["']/);
    out.set(key, baseMatch ? baseMatch[1]! : key);
  }

  return out;
}

/**
 * Locate `const|let|var <identifier> = <value>` at any depth in the source
 * and return the captured `<value>` text. Used to resolve shorthand
 * collection entries (`{ docs }` in the registration object refers to a
 * `const docs = defineCollection(...)` declared somewhere above).
 *
 * The walker is brace/bracket/paren-aware and string-literal-aware so the
 * captured value spans nested object/function-call expressions without
 * losing depth. It stops at the next top-level `;` or end-of-input.
 *
 * Limitations (false negatives — never false positives):
 *   - Identifiers imported from other modules can't be resolved (we don't
 *     follow imports).
 *   - Type-only annotations using `=>` (`const docs: () => X = …`) would
 *     fool the `=` detection. Realistic collection declarations don't use
 *     this shape; if a user does, the check falls back to the key.
 */
function findLocalDeclarationValue(
  source: string,
  identifier: string,
): string {
  const found = findLocalDeclaration(source, identifier);
  return found ? source.slice(found.start, found.end) : "";
}

/** Where `findLocalDeclarationValue`'s value text is, or undefined. */
function findLocalDeclaration(
  source: string,
  identifier: string,
): { start: number; end: number } | undefined {
  const safeId = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${safeId}\\b`, "g");

  let match: RegExpExecArray | null;
  while ((match = declRe.exec(source)) !== null) {
    const afterId = match.index + match[0].length;
    const eqIdx = findAssignmentEquals(source, afterId);
    if (eqIdx === -1) continue;
    return { start: eqIdx + 1, end: findStatementEnd(source, eqIdx + 1) };
  }
  return undefined;
}

/**
 * Find the first `=` after `from` that's an assignment operator —
 * skipping `==`, `===`, and `=>`. Used to locate where the assignment
 * value begins in `const id [: Type] = value;`.
 */
function findAssignmentEquals(source: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] !== "=") continue;
    if (source[i + 1] === "=") {
      i++; // skip `==` (and `===` since next iter handles the trailing `=`)
      continue;
    }
    if (source[i + 1] === ">") {
      i++; // skip `=>`
      continue;
    }
    if (source[i - 1] === "!" || source[i - 1] === "<" || source[i - 1] === ">") {
      continue; // `!=`, `<=`, `>=`
    }
    return i;
  }
  return -1;
}

/**
 * Walk forward from `from` tracking brace/bracket/paren depth and string
 * literals; return the index of the statement terminator.
 *
 * Terminates at the first of:
 *   1. A top-level `;`.
 *   2. A top-level newline that occurs *after* the value expression has
 *      produced any non-whitespace content. This is the ASI rule the
 *      walker has to honor for semicolonless code:
 *
 *      ```
 *      const docs = defineCollection(docsCollection())   // ← stop here
 *      export const collections = { … }                  // ← not part of `docs`
 *      ```
 *
 *      Without the ASI rule the walker would swallow the next statement
 *      and the `base:` regex could read an unrelated value.
 *   3. End-of-input.
 *
 * The "after non-whitespace" gate handles the leading-newline case:
 *
 *      ```
 *      const docs =
 *        defineCollection(docsCollection({ base: "x" }))
 *      ```
 *
 *      Here the newline right after `=` doesn't terminate; the walker
 *      keeps scanning until the value starts. Once content has been seen,
 *      the next top-level newline ends the statement.
 *
 * Limitations: method-chain continuations like `defineCollection(…)\n  .extend(…)`
 * stop at the first `)`. That captures the inner call's options (where any
 * `base:` would live), so the result is still correct in practice.
 */
function findStatementEnd(source: string, from: number): number {
  let depth = 0;
  let inString: string | null = null;
  let sawContent = false;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      sawContent = true;
    } else if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      sawContent = true;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
    } else if (ch === ";" && depth === 0) {
      return i;
    } else if (ch === "\n" && depth === 0 && sawContent) {
      return i;
    } else if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
      sawContent = true;
    }
  }
  return source.length;
}

/** Where a page collection's files are, as far as the config shows statically. */
export type StaticPageCollection =
  | { kind: "folder"; dir: string; pattern: string | string[]; role: "page" | "partials" }
  /** `docsCollection({ source })`: the folder is inside that source's snapshot. */
  | { kind: "source"; source: string; base: string; pattern: string | string[]; role: "page" }
  /** A page collection whose files can't be placed without running the config. */
  | { kind: "unplaced" };

// The factory as the collection's whole value (`defineCollection(docsCollection(…))`
// or bare `docsCollection(…)`), not a `schema: docsCollection().schema` inside
// a hand-written collection.
const NIMBUS_FACTORY =
  /^\s*(?:defineCollection\s*\(\s*)?(docsCollection|partialsCollection|componentsCollection)\s*\(/;
const FACTORY_DEFAULT_BASE: Record<string, string> = {
  docsCollection: "docs",
  partialsCollection: "partials",
  componentsCollection: "components",
};
const DEFAULT_PAGE_PATTERN = "**/*.{md,mdx}";

function literalOption(text: string, name: string): string | undefined {
  return text.match(new RegExp(`\\b${name}\\s*:\\s*["'\`]([^"'\`$]+)["'\`]`))?.[1];
}

/**
 * The static phase of the page-collection contract, for `lint` and `check`
 * (which run without a build): each page and partials collection in
 * `content.config.ts` with the folder its files load from.
 *
 *   - a Nimbus factory (`docsCollection()` and friends): `src/content/<base>`,
 *     with a literal `pattern` when given;
 *   - `docsCollection({ source: "<name>" })`: that source, with a literal
 *     `base` and `pattern`; a `source` that isn't a string literal (a
 *     variable, the shorthand `{ source }`) is `unplaced`;
 *   - `withNimbusMarkdown(glob({ base: "…" }))`, written inline or through a
 *     local `const`: the literal `base`, relative to the project root;
 *   - any other `withNimbusMarkdown()` loader (in-memory, computed options):
 *     `unplaced`, so callers can name it as not inspected.
 *
 * Plain Astro collections aren't page collections and are left out. `null`
 * when the file is missing or has no parseable registration.
 */
export function parsePageCollectionFolders(
  projectRoot: string,
  contentConfigPath: string,
): Map<string, StaticPageCollection> | null {
  return readPageCollections(projectRoot, contentConfigPath)?.places ?? null;
}

/** Which collections read each source, as far as the config shows statically. */
export interface PageCollectionSources {
  /** `parsePageCollectionFolders`'s map; null when the file has no parseable registration. */
  places: Map<string, StaticPageCollection> | null;
  /** Source name → the collections that read it with a literal `source`, in config order. */
  readers: Map<string, string[]>;
  /**
   * What may read a source without the map showing it: `collection "sdk"`,
   * ``the entry `...localeCollections` ``, a `docsCollection(…)` call outside
   * any entry. Empty when the map shows every read.
   */
  hidden: string[];
}

/**
 * `parsePageCollectionFolders` plus the source reads, for a build that
 * fetches only the sources its collections read. Only `docsCollection({ source })`
 * reads a source, so every `docsCollection(` call in the file is looked at:
 * one with no argument or an object literal without a `source` key
 * (`docsCollection().schema`, `docsCollection({ base })`) reads nothing; one
 * the map placed with a literal `source` is in `readers`; any other with a
 * `source` key or shorthand, a spread, or a non-literal argument hides a
 * read. So do spread and computed entries, and values that are identifiers
 * the file doesn't declare (imported collections). A missing file reads
 * nothing.
 */
export function parsePageCollectionSources(
  projectRoot: string,
  contentConfigPath: string,
): PageCollectionSources {
  return (
    readPageCollections(projectRoot, contentConfigPath) ?? {
      places: null,
      readers: new Map(),
      hidden: [],
    }
  );
}

// A `source` key or shorthand in an options object: `source:`, `"source":`,
// `{ source }`, `, source,`.
const SOURCE_KEY = /(?:^|[{,])\s*(["'`]?)source\1\s*(?=[:,}])/;

/** The index of the bracket closing the one at `openIdx`, skipping strings; -1 if none. */
function findMatchingClose(input: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIdx; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** An object literal's text with everything nested inside its values blanked. */
function topLevelText(object: string): string {
  let depth = 0;
  let inString: string | null = null;
  let out = "";
  for (let i = 0; i < object.length; i++) {
    const ch = object[i]!;
    let keep = depth <= 1;
    if (inString) {
      if (ch === "\\") {
        out += keep ? ch + (object[i + 1] ?? "") : "  ";
        i++;
        continue;
      }
      if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      keep = depth <= 1;
    } else if (ch === "}" || ch === "]" || ch === ")") depth--;
    out += keep ? ch : " ";
  }
  return out;
}

const shortText = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
};

function readPageCollections(
  projectRoot: string,
  contentConfigPath: string,
): PageCollectionSources | null {
  let source: string;
  try {
    source = readFileSync(contentConfigPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const stripped = stripComments(source);
  const blanked = stripStrings(stripped);
  const readers = new Map<string, string[]>();
  const hidden: string[] = [];
  // The `(` of each `docsCollection(` call placed as a literal source.
  const placedCalls = new Set<number>();
  // Each entry's text, and the declaration a shorthand or identifier names.
  const entryRanges: Array<{ name: string; start: number; end: number }> = [];

  const prefixMatch = stripped.match(EXPORT_PREFIX_PATTERN);
  const objectStart =
    prefixMatch?.index === undefined ? -1 : prefixMatch.index + prefixMatch[0].length;
  const objectEnd = objectStart === -1 ? -1 : findMatchingBrace(stripped, objectStart - 1);
  let places: Map<string, StaticPageCollection> | null = null;
  if (objectEnd === -1) {
    hidden.push("`export const collections`");
  } else {
    places = new Map();
    let offset = objectStart;
    for (const raw of splitTopLevelCommas(stripped.slice(objectStart, objectEnd))) {
      const entryStart = offset + (raw.length - raw.trimStart().length);
      offset += raw.length + 1;
      const entry = raw.trim();
      if (!entry) continue;
      if (entry.startsWith("...") || entry.startsWith("[")) {
        hidden.push(`the entry \`${shortText(entry.startsWith("[") ? entry.slice(0, entry.indexOf("]") + 1) : entry)}\``);
        continue;
      }
      const colonIdx = entry.indexOf(":");
      const key = (colonIdx === -1 ? entry : entry.slice(0, colonIdx))
        .trim()
        .replace(/^['"`]|['"`]$/g, "");
      const name = `collection "${key}"`;
      entryRanges.push({ name, start: entryStart, end: entryStart + entry.length });
      let value: string;
      let valueStart: number;
      if (colonIdx === -1) {
        const declaration = findLocalDeclaration(stripped, key);
        if (!declaration) {
          hidden.push(name); // Imported.
          continue;
        }
        entryRanges.push({ name, ...declaration });
        value = stripped.slice(declaration.start, declaration.end);
        valueStart = declaration.start;
      } else {
        value = entry.slice(colonIdx + 1);
        valueStart = entryStart + colonIdx + 1;
        // `sdk: sdkCollection` or `defineCollection(sdkOptions)`: follow a
        // local declaration; an imported one can't be read.
        const identifier = value.match(
          /^\s*(?:defineCollection\s*\(\s*)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\)?\s*$/,
        )?.[1];
        if (identifier) {
          const declaration = /^[\w$]+$/.test(identifier)
            ? findLocalDeclaration(stripped, identifier)
            : undefined;
          if (!declaration) {
            hidden.push(name);
            continue;
          }
          entryRanges.push({ name, ...declaration });
          value = stripped.slice(declaration.start, declaration.end);
          valueStart = declaration.start;
        }
      }
      if (!COLLECTION_KEY.test(key)) continue;
      const place = placeEntry(projectRoot, stripped, value);
      if (!place) {
        // Not a Nimbus collection the text shows: a helper or imported
        // function (`makeSdk("b")`), an aliased factory, a conditional may
        // build a source collection.
        if (!readsNoSource(value)) hidden.push(name);
        continue;
      }
      places.set(key, place);
      if (place.kind === "source") {
        placedCalls.add(valueStart + value.match(NIMBUS_FACTORY)![0].length - 1);
        const list = readers.get(place.source) ?? [];
        list.push(key);
        readers.set(place.source, list);
      }
    }
  }

  // `docsCollection(`, and any name it's imported under
  // (`import { docsCollection as dc }`); `ns.docsCollection(` matches as is.
  const aliases = [...stripped.matchAll(/\bdocsCollection\s+as\s+([A-Za-z_$][\w$]*)/g)].map((m) =>
    m[1]!.replace(/\$/g, "\\$"),
  );
  // Not `\b`: an identifier may start with `$`, which `\b` never precedes.
  const calls = new RegExp(`(?<![\\w$])(?:${["docsCollection", ...aliases].join("|")})\\s*\\(`, "g");
  for (const call of blanked.matchAll(calls)) {
    const open = call.index + call[0].length - 1;
    if (placedCalls.has(open)) continue;
    const close = findMatchingClose(stripped, open);
    const arg = stripped.slice(open + 1, close === -1 ? undefined : close).trim();
    const argBlanked = blanked.slice(open + 1, close === -1 ? undefined : close).trim();
    const objectLiteral =
      arg === "" || (arg.startsWith("{") && findMatchingBrace(arg, 0) === arg.length - 1);
    if (close !== -1 && objectLiteral && !argBlanked.includes("...") && !SOURCE_KEY.test(arg)) continue;
    const owner = entryRanges.find((range) => open >= range.start && open < range.end);
    hidden.push(owner?.name ?? `\`docsCollection(${shortText(arg)})\``);
  }
  return { places, readers, hidden: [...new Set(hidden)] };
}

// Nimbus factories that never read a source.
const SOURCE_FREE_FACTORY = /^(?:partialsCollection|componentsCollection|apiCollection)\s*\(/;

/**
 * Whether an entry the map doesn't place reads no source: `defineCollection`
 * over an object literal (its calls are scanned on their own) or over a
 * source-free Nimbus factory. Anything else, a call to a helper or an
 * imported or aliased function, a conditional, may build a source collection.
 */
function readsNoSource(value: string): boolean {
  const text = value.trim().replace(/;$/, "").trim();
  const wrapped = /^defineCollection\s*\(/.exec(text);
  const inner = wrapped ? text.slice(wrapped[0].length).trimStart() : text;
  return (wrapped !== null && inner.startsWith("{")) || SOURCE_FREE_FACTORY.test(inner);
}

/** Where one collection's files are, from its value text; undefined for a plain Astro collection. */
function placeEntry(
  projectRoot: string,
  stripped: string,
  value: string,
): StaticPageCollection | undefined {
  const factory = value.match(NIMBUS_FACTORY);
  if (factory) {
    const options = value.slice(factory.index! + factory[0].length);
    const source = literalOption(options, "source");
    // A top-level `source` key; a schema field named `source` isn't one.
    const object = options.trimStart().startsWith("{")
      ? options.trimStart().slice(0, findMatchingBrace(options.trimStart(), 0) + 1)
      : "";
    if (factory[1] === "docsCollection" && SOURCE_KEY.test(topLevelText(object))) {
      return source
        ? {
            kind: "source",
            source,
            base: literalOption(options, "base") ?? "",
            pattern: literalOption(options, "pattern") ?? DEFAULT_PAGE_PATTERN,
            role: "page",
          }
        : { kind: "unplaced" };
    }
    const base = literalOption(options, "base") ?? FACTORY_DEFAULT_BASE[factory[1]!]!;
    return {
      kind: "folder",
      dir: path.join(projectRoot, "src/content", base),
      pattern: literalOption(options, "pattern") ?? DEFAULT_PAGE_PATTERN,
      role: factory[1] === "partialsCollection" ? "partials" : "page",
    };
  }
  const wrapper = value.match(/\bwithNimbusMarkdown\s*\(\s*/);
  if (!wrapper) return undefined;
  let loaderText = value.slice(wrapper.index! + wrapper[0].length);
  const identifier = loaderText.match(/^([A-Za-z_$][\w$]*)\s*\)/)?.[1];
  if (identifier) loaderText = findLocalDeclarationValue(stripped, identifier);
  const globCall = loaderText.match(/^\s*glob\s*\(\s*\{/);
  const globOptions = globCall
    ? loaderText.slice(globCall[0].length, findMatchingBrace(loaderText, globCall[0].length - 1))
    : "";
  const base = globCall ? literalOption(globOptions, "base") : undefined;
  return base
    ? {
        kind: "folder",
        dir: path.resolve(projectRoot, base),
        pattern: literalOption(globOptions, "pattern") ?? DEFAULT_PAGE_PATTERN,
        role: "page",
      }
    : { kind: "unplaced" };
}

export type PlacedPageCollection =
  | { kind: "folder"; dir: string; pattern: string | string[]; role: "page" | "partials"; source?: string }
  | { kind: "unplaced"; reason: string };

/**
 * Resolve each `source` collection to a folder inside the snapshot the last
 * build or dev start selected (`snapshots`: source name → its `path` folder).
 * A source with no snapshot yet stays unplaced, with the reason.
 */
export function placeStaticCollections(
  parsed: ReadonlyMap<string, StaticPageCollection> | null,
  snapshots: ReadonlyMap<string, { contentDir: string }>,
): Map<string, PlacedPageCollection> {
  const out = new Map<string, PlacedPageCollection>();
  for (const [key, place] of parsed ?? []) {
    if (place.kind === "folder") out.set(key, place);
    else if (place.kind === "unplaced") {
      out.set(key, { kind: "unplaced", reason: "its loader isn't a glob over a folder" });
    } else {
      const snapshot = snapshots.get(place.source);
      const base = place.base.replaceAll("\\", "/").replace(/^\.\//, "");
      out.set(
        key,
        snapshot && !base.split("/").includes("..")
          ? { kind: "folder", dir: path.join(snapshot.contentDir, base), pattern: place.pattern, role: "page", source: place.source }
          : { kind: "unplaced", reason: `source "${place.source}" has no snapshot: not fetched yet, or unreachable at the last start; run a build or start the dev server` },
      );
    }
  }
  return out;
}
