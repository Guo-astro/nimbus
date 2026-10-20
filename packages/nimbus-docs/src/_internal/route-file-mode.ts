/**
 * Set a route file to build or request mode, the way the starter writes it:
 * a `prerender` line only when the mode differs from Astro's `output`
 * default, and `getStaticPaths` only on built routes. Edits only the starter's
 * literal shapes; anything else is left for the author, with what to change.
 */

import ts from "typescript";

import type { RenderingMode } from "../types.js";
import { isStaticPathsHelper, PAGE_HELPERS, takesCollection, type StaticPathsHelper } from "./route-helpers.js";
import type { AstroOutput } from "./route-modes.js";

const RUNTIME = "@cloudflare/nimbus-docs/runtime";
// Agent factories whose routes are dynamic, so a built one exports its paths.
const AGENT_PATHS = new Set(["markdownRoute", "markdownSourceRoute", "llmsSectionRoute"]);

const PRERENDER_LINE = /^[ \t]*export\s+const\s+prerender\s*=\s*(?:true|false)\s*;?[ \t]*(?:\r?\n|$)/gmu;
const AGENT_LINE =
  /^([ \t]*export\s+const\s*\{\s*GET)\s*(?:,\s*getStaticPaths\s*)?,?\s*(\}\s*=\s*(markdownRoute|markdownSourceRoute|llmsSectionRoute|llmsRoute|llmsFullRoute)\(\s*\)\s*;?)/gmu;

export interface RouteFileTarget {
  mode: RenderingMode;
  output: AstroOutput;
  /**
   * For a collection's page route: its name, the `getStaticPaths` value that
   * builds it (`getDocsStaticPaths`, `getCollectionStaticPaths("sdk")`), and
   * whether it's served away from its default URL, where a request route
   * names the collection in its page helper.
   */
  page?: { collection: string; paths: string; moved: boolean };
}

export type RouteFileEdit =
  | { status: "unchanged" }
  | { status: "updated"; source: string }
  /** Not in the starter's shape: `source` has the edits that could be made, `todo` what's left. */
  | { status: "manual"; source: string; todo: string };

export function setRouteFileMode(file: string, source: string, target: RouteFileTarget): RouteFileEdit {
  const frontmatter = file.endsWith(".astro") ? /^(\s*---\r?\n)([\s\S]*?)(^---)/mu.exec(source) : null;
  if (file.endsWith(".astro") && !frontmatter)
    return { status: "manual", source, todo: "Its frontmatter couldn't be read." };
  const start = frontmatter ? frontmatter[1]!.length : 0;
  const end = frontmatter ? start + frontmatter[2]!.length : source.length;
  const { code, todo } = editCode(source.slice(start, end), target);
  const next = source.slice(0, start) + code + source.slice(end);
  if (todo) return { status: "manual", source: next, todo };
  return next === source ? { status: "unchanged" } : { status: "updated", source: next };
}

function editCode(input: string, target: RouteFileTarget): { code: string; todo?: string } {
  const prerenders = [...input.matchAll(PRERENDER_LINE)];
  const agents = [...input.matchAll(AGENT_LINE)];
  const paths = helperPathsExports(input);
  if (prerenders.length > 1) return { code: input, todo: "It sets `prerender` more than once; keep one line." };
  if (agents.length + paths.length > 1) return { code: input, todo: "It exports getStaticPaths more than once." };

  const build = target.mode === "build";
  let code = prerenders.length ? removeLine(input, prerenders[0]![0]) : input;
  let addPaths: string | undefined;
  let todo: string | undefined;
  if (agents.length) {
    const [line, start, end, factory] = agents[0]!;
    code = code.replace(line, `${start}${build && AGENT_PATHS.has(factory!) ? ", getStaticPaths" : ""} ${end}`);
  } else if (paths.length) {
    if (!build) {
      code = removeLine(code, paths[0]!.line);
      code = dropUnusedImport(code, paths[0]!.helper);
    }
  } else if (code.includes("getStaticPaths")) {
    if (!build) todo = "Remove its getStaticPaths export: the route renders on request.";
  } else if (build && target.page) {
    addPaths = withHelperOptions(target.page.paths, code);
  }
  if (!build && target.page?.moved) {
    const named = nameCollectionInHelpers(code, target.page.collection);
    if (named === undefined)
      todo ??= `Pass "${target.page.collection}" to its page helper, such as getCollectionPage(Astro, "${target.page.collection}").`;
    else code = named;
  }

  const lines = [
    ...(build === (target.output === "server") ? [`export const prerender = ${build};`] : []),
    ...(addPaths ? [`export const getStaticPaths = ${addPaths};`] : []),
  ];
  if (lines.length) code = insertAfterImports(code, lines);
  if (addPaths) code = addRuntimeImport(code, addPaths.replace(/\(.*$/su, ""));
  return { code, ...(todo ? { todo } : {}) };
}

/** `export const getStaticPaths = <helper>(…)` statements, as the starter writes them. */
function helperPathsExports(code: string): { line: string; helper: StaticPathsHelper }[] {
  return parse(code).statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
    const [declaration, ...rest] = statement.declarationList.declarations;
    if (rest.length || !declaration || !ts.isIdentifier(declaration.name) || declaration.name.text !== "getStaticPaths") return [];
    const value = declaration.initializer;
    const helper = value && helperIn(value);
    return helper ? [{ line: lineOf(code, statement), helper }] : [];
  });
}

function helperIn(value: ts.Expression): StaticPathsHelper | undefined {
  if (ts.isIdentifier(value)) return isStaticPathsHelper(value.text) && !takesCollection(value.text) ? value.text : undefined;
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return undefined;
  const name = value.expression.text;
  const [collection] = value.arguments;
  return isStaticPathsHelper(name) && takesCollection(name) && collection && ts.isStringLiteralLike(collection) ? name : undefined;
}

/** An API route's options (`{ homeChunkSize }`) go to both helpers, so a
 *  restored `getApiStaticPaths` takes the ones its page helper passes. */
function withHelperOptions(paths: string, code: string): string {
  if (!paths.startsWith("getApiStaticPaths(")) return paths;
  const options = pageHelperCalls(code)
    .flatMap((call) => call.arguments.slice(1))
    .find((argument) => !ts.isStringLiteralLike(argument));
  return options ? `${paths.slice(0, -1)}, ${options.getText()})` : paths;
}

function pageHelperCalls(code: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && PAGE_HELPERS.has(node.expression.text)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parse(code));
  return calls;
}

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("route.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Remove a whole line, and a blank line it leaves doubled. */
function removeLine(code: string, line: string): string {
  const at = code.indexOf(line);
  const before = code.slice(0, at);
  let after = code.slice(at + line.length);
  if ((before === "" || before.endsWith("\n\n")) && /^\r?\n/u.test(after)) after = after.replace(/^\r?\n/u, "");
  return before + after;
}

/**
 * Insert `lines` after the last top-level import, preceded by one blank
 * line, and followed by one unless the next line is another export, as the
 * starter writes `prerender` above `getStaticPaths`.
 */
function insertAfterImports(code: string, lines: string[]): string {
  const block = `${lines.join("\n")}\n`;
  const last = parse(code).statements.filter(ts.isImportDeclaration).at(-1);
  const newline = last ? code.indexOf("\n", last.getEnd()) : -1;
  const before = !last ? "" : newline === -1 ? `${code}\n` : code.slice(0, newline + 1);
  const rest = (last ? (newline === -1 ? "" : code.slice(newline + 1)) : code).replace(/^(?:[ \t]*\r?\n)+/u, "");
  const gap = rest === "" || /^export\s+const\s+(?:getStaticPaths\b|\{)/u.test(rest) ? "" : "\n";
  return `${before}${before ? "\n" : ""}${block}${gap}${rest}`;
}

/** Remove a named runtime import nothing else references. */
function dropUnusedImport(code: string, name: string): string {
  const sourceFile = parse(code);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  let body = code;
  for (const statement of [...imports].reverse()) body = body.slice(0, statement.getStart()) + body.slice(statement.getEnd());
  if (new RegExp(String.raw`(?<![\w$.])${name}(?![\w$])`, "u").test(body)) return code;
  for (const statement of imports) {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith("@cloudflare/nimbus-docs"))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const index = bindings.elements.findIndex((item) => item.name.text === name && !item.propertyName);
    if (index === -1) continue;
    const element = bindings.elements[index]!;
    if (bindings.elements.length === 1 && !statement.importClause?.name) return removeLine(code, lineOf(code, statement));
    if (bindings.getText().includes("\n")) return removeLine(code, lineOf(code, element));
    const next = bindings.elements[index + 1];
    const [from, to] = next ? [element.getStart(), next.getStart()] : [bindings.elements[index - 1]!.getEnd(), element.getEnd()];
    return code.slice(0, from) + code.slice(to);
  }
  return code;
}

/** The full line(s) a node spans, with the newline after. */
function lineOf(code: string, node: ts.Node): string {
  const start = code.lastIndexOf("\n", node.getStart() - 1) + 1;
  const end = code.indexOf("\n", node.getEnd());
  return code.slice(start, end === -1 ? code.length : end + 1);
}

/** Add `name` to the runtime import, or a new import after the last one. */
function addRuntimeImport(code: string, name: string): string {
  const imports = parse(code).statements.filter(ts.isImportDeclaration);
  for (const statement of imports) {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== RUNTIME) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.isTypeOnly) continue;
    if (bindings.elements.some((item) => item.name.text === name && !item.propertyName)) return code;
    const open = bindings.getStart() + 1;
    const first = bindings.elements[0];
    if (first && bindings.getText().includes("\n")) {
      const indent = code.slice(code.lastIndexOf("\n", first.getStart()) + 1, first.getStart());
      return `${code.slice(0, open)}\n${indent}${name},${code.slice(open)}`;
    }
    return `${code.slice(0, open)} ${name},${code.slice(open)}`;
  }
  const line = `import { ${name} } from "${RUNTIME}";\n`;
  const last = imports.at(-1);
  if (!last) return line + code;
  const newline = code.indexOf("\n", last.getEnd());
  return newline === -1 ? `${code}\n${line}` : code.slice(0, newline + 1) + line + code.slice(newline + 1);
}

/**
 * Pass the collection to each page helper that doesn't name one, after
 * `Astro` and before any options, dropping a literal type argument it
 * replaces; `undefined` when the file calls none.
 */
function nameCollectionInHelpers(code: string, collection: string): string | undefined {
  const calls = pageHelperCalls(code);
  if (calls.length === 0) return undefined;
  let out = code;
  for (const call of calls.reverse()) {
    const named = call.arguments[1];
    if (call.arguments.length === 0 || (named && ts.isStringLiteralLike(named))) continue;
    const at = call.arguments[0]!.getEnd();
    out = `${out.slice(0, at)}, ${JSON.stringify(collection)}${out.slice(at)}`;
    const type = call.typeArguments?.length === 1 ? call.typeArguments[0]! : undefined;
    if (type && ts.isLiteralTypeNode(type)) out = out.slice(0, type.getStart() - 1) + out.slice(type.getEnd() + 1);
  }
  return out;
}
