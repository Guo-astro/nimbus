/**
 * Set a route file to build or request mode, the way the starter writes it:
 * a `prerender` line only when the mode differs from Astro's `output`
 * default, and `getStaticPaths` only on built routes. Edits only the starter's
 * literal shapes; anything else is left for the author, with what to change.
 */

import ts from "typescript";

import type { RenderingMode } from "../types.js";
import {
  isRuntimeModule,
  isStaticPathsHelper,
  PAGE_HELPERS,
  staticPathsFor,
  takesCollection,
  type PageRouteKind,
  type StaticPathsHelper,
} from "./route-helpers.js";
import { exportedNames, importedName, isAstroFile, parseRouteCode, readRouteExports, routeCode, routeProgram } from "./route-exports.js";
import { isDynamicRoute, routeFileMismatch, type AstroOutput } from "./route-modes.js";

const RUNTIME = "@cloudflare/nimbus-docs/runtime";
// Agent factories whose routes are dynamic, so a built one exports its paths.
const AGENT_PATHS = new Set(["markdownRoute", "markdownSourceRoute", "llmsSectionRoute"]);

const AGENT_FACTORIES = new Set([...AGENT_PATHS, "llmsRoute", "llmsFullRoute"]);
const AGENT_MODULE = "@cloudflare/nimbus-docs/agent-endpoints";

export interface RouteFileTarget {
  mode: RenderingMode;
  output: AstroOutput;
  /**
   * For a collection's page route: its name, which helpers serve it, and
   * whether it's served away from its default URL, where a request route
   * must name the collection in its page helper.
   */
  page?: { collection: string; kind: PageRouteKind; moved: boolean };
}

export type RouteFileEdit =
  | { status: "unchanged" }
  | { status: "updated"; source: string }
  /** Not in the starter's shape: `source` has the edits that could be made, `todo` what's left. */
  | { status: "manual"; source: string; todo: string };

export function setRouteFileMode(file: string, source: string, target: RouteFileTarget): RouteFileEdit {
  const script = routeCode(file, source);
  if (!script) return { status: "manual", source, todo: "It has no frontmatter opening the file (`---` on the first line) for Nimbus to edit." };
  const { code, todo } = editCode(script.code, target, !isAstroFile(file));
  const next = source.slice(0, script.start) + code + source.slice(script.start + script.code.length);
  // The editor never removes another name the file declares or exports, nor one its template reads,
  // never adds a TypeScript error, and never stops short of a match.
  const before = parseRouteCode(script.code);
  const after = parseRouteCode(code);
  const kept = topLevelNames(after);
  const shapeTodo = `Nimbus can't edit this file's shape: ${neededState(file, script.code, target)}.`;
  const template = isAstroFile(file) ? source.slice(script.start + script.code.length) : "";
  const keptInScope = new Set([...kept, ...importedNames(after)]);
  const read = [...topLevelNames(before), ...importedNames(before)].find((name) => !keptInScope.has(name) && readsName(template, name));
  if (read)
    return { status: "manual", source, todo: `Its template reads \`${read}\`, which Nimbus would remove: ${neededState(file, script.code, target)}, then update the template.` };
  const unsafe =
    [...topLevelNames(before)].some((name) => !STATE_EXPORTS.has(name) && !kept.has(name)) || introducesErrors(script.code, code);
  if (unsafe) return { status: "manual", source, todo: todo ?? shapeTodo };
  if (todo) return { status: "manual", source: next, todo };
  if (routeFileMismatch({ file, source: next, output: target.output, expected: target.mode }))
    return { status: "manual", source, todo: shapeTodo };
  return next === source ? { status: "unchanged" } : { status: "updated", source: next };
}

const STATE_EXPORTS = new Set(["prerender", "getStaticPaths"]);

/** Whether `after` has a TypeScript error `before` doesn't, such as a name it no longer declares or imports twice. */
function introducesErrors(before: string, after: string): boolean {
  const known = checkerErrors(before);
  return [...checkerErrors(after)].some((error) => !known.has(error));
}

function checkerErrors(code: string): Set<string> {
  // A module, as Astro compiles frontmatter, so top-level `await` stays valid without imports or exports.
  const sourceFile = parseRouteCode(`${code}\nexport {};\n`);
  const program = routeProgram(sourceFile);
  return new Set(
    [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]
      .filter((d) => !UNRESOLVED_MODULE.has(d.code))
      .map((d) => `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`),
  );
}

/** "Cannot find module" errors, which every import raises when the checker resolves none. */
const UNRESOLVED_MODULE = new Set([2307, 2792]);

/** The names the code declares or exports at the top level, imports aside. */
function topLevelNames(sourceFile: ts.SourceFile): Set<string> {
  const names = exportedNames(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations) for (const name of bindingNames(d.name)) names.add(name);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
  }
  return names;
}

function importedNames(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (!clause) return [];
    const bindings = clause.namedBindings;
    const named = !bindings ? [] : ts.isNamespaceImport(bindings) ? [bindings.name.text] : bindings.elements.map((e) => e.name.text);
    return clause.name ? [clause.name.text, ...named] : named;
  });
}

/** Whether an `.astro` template mentions `name` as a word: perhaps only in text, but Nimbus can't tell without compiling it. */
function readsName(template: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name.replaceAll("$", "\\$")}(?![\\w$])`, "u").test(template);
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

/** What a file needs to be in `target`'s mode, for one Nimbus can't edit. */
function neededState(file: string, code: string, target: RouteFileTarget): string {
  const build = target.mode === "build";
  const { prerenders, staticPaths } = readRouteExports(parseRouteCode(code), !isAstroFile(file));
  const wanted = build === (target.output === "server") ? build : undefined;
  const steps: string[] = [];
  if (wanted !== undefined && prerenders[0]?.value !== wanted) steps.push(`set \`export const prerender = ${wanted};\``);
  if (wanted === undefined && prerenders.length > 0) steps.push("remove its `prerender` line");
  if (!build && staticPaths) steps.push("remove its getStaticPaths export");
  if (build && isDynamicRoute(file) && !staticPaths)
    steps.push(
      target.page
        ? `add \`export const getStaticPaths = ${staticPathsFor(target.page.collection, target.page.kind)};\``
        : "export getStaticPaths from the factory that makes its GET, such as `export const getStaticPaths = route.getStaticPaths;`",
    );
  return steps.join(", and ");
}

function editCode(input: string, target: RouteFileTarget, namedExports: boolean): { code: string; todo?: string } {
  const build = target.mode === "build";
  const { prerenders, listedPrerender, staticPaths } = readRouteExports(parseRouteCode(input), namedExports);
  const agents = agentExports(input);
  const paths = helperPathsExports(input);
  if (prerenders.length > 1) return { code: input, todo: "It sets `prerender` more than once; keep one line." };
  if (listedPrerender)
    return { code: input, todo: "It exports `prerender` from a list; declare it as `export const prerender = …;`, which Nimbus can edit." };
  if (prerenders[0] && prerenders[0].statement.declarationList.declarations.length > 1)
    return { code: input, todo: "Its `prerender` shares a statement with other exports; give it a statement of its own (`export const prerender = …;`)." };
  if (prerenders[0] && prerenders[0].value === undefined) {
    const line = build === (target.output === "server") ? `set it to \`export const prerender = ${build};\`` : "remove it";
    const factory = agents[0]?.factory;
    const needsPaths = build && !staticPaths && (target.page || (factory && AGENT_PATHS.has(factory)));
    const paths = !needsPaths
      ? ""
      : target.page
        ? ` Then add \`export const getStaticPaths = ${staticPathsFor(target.page.collection, target.page.kind)};\`.`
        : ` Then export getStaticPaths from its factory: \`export const { GET, getStaticPaths } = ${factory}();\`.`;
    return { code: input, todo: `Its \`prerender\` is an expression: ${line}.${paths}` };
  }
  if (agents.length + paths.length > 1) return { code: input, todo: "It exports getStaticPaths more than once." };

  // A moved route's getStaticPaths may be the only place it names its collection.
  const unread = target.page?.kind !== "docs" && pageHelperCalls(input).some((call) => helperArguments(call).named === undefined);
  if (!build && paths.length && target.page?.moved && unread)
    return {
      code: input,
      todo: `Pass "${target.page.collection}" to its page helper first, such as getApiRoute(Astro, "${target.page.collection}", options): its getStaticPaths is the only place it names the collection.`,
    };

  let code = prerenders[0] ? removeNode(input, prerenders[0].statement) : input;
  let addPaths: string | undefined;
  let reads = new Set<string>();
  let todo: string | undefined;
  if (agents.length) {
    const { pattern, factory } = agentExports(code)[0]!;
    const names = `{ GET${build && AGENT_PATHS.has(factory) ? ", getStaticPaths" : ""} }`;
    code = code.slice(0, pattern.getStart()) + names + code.slice(pattern.getEnd());
  } else if (paths.length) {
    if (!build) {
      code = removeNode(code, helperPathsExports(code)[0]!.statement);
      code = dropUnusedImport(code, paths[0]!.helper);
    }
  } else if (staticPaths) {
    if (!build) todo = "Remove its getStaticPaths export, and imports only it uses: the route renders on request.";
  } else if (build && target.page) {
    const paths = builtStaticPaths(target.page, code);
    if ("todo" in paths) todo = paths.todo;
    else ({ value: addPaths, reads } = paths);
  }
  if (target.page && target.page.kind !== "docs") {
    const named = nameCollectionInHelpers(code, target.page.collection);
    if (named !== undefined) code = named;
    else if (!build && target.page.moved)
      todo ??= `Pass "${target.page.collection}" to its page helper, such as getCollectionPage(Astro, "${target.page.collection}").`;
  }

  const pathsLine = addPaths ? `export const getStaticPaths = ${addPaths};` : undefined;
  if (pathsLine && reads.size) code = insertAfterDeclarations(code, reads, pathsLine);
  const lines = [
    ...(build === (target.output === "server") ? [`export const prerender = ${build};`] : []),
    ...(pathsLine && !reads.size ? [pathsLine] : []),
  ];
  if (lines.length) code = insertAfterImports(code, lines);
  if (addPaths) code = addRuntimeImport(code, addPaths.replace(/\(.*$/su, ""));
  return { code, ...(todo ? { todo } : {}) };
}

/** `export const { GET, getStaticPaths } = <factory>()` statements, as the starter writes them. */
function agentExports(code: string): { pattern: ts.ObjectBindingPattern; factory: string }[] {
  const sourceFile = parseRouteCode(code);
  const { agent } = nimbusNames(sourceFile);
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
    const [declaration, ...rest] = statement.declarationList.declarations;
    if (rest.length || !declaration || !ts.isObjectBindingPattern(declaration.name)) return [];
    const names = declaration.name.elements.map((e) => (!e.propertyName && !e.initializer && !e.dotDotDotToken && ts.isIdentifier(e.name) ? e.name.text : ""));
    if (!names.includes("GET") || names.some((name) => name !== "GET" && name !== "getStaticPaths")) return [];
    const call = declaration.initializer;
    if (!call || !ts.isCallExpression(call) || call.arguments.length) return [];
    const factory = agent(call.expression);
    return factory && AGENT_FACTORIES.has(factory) ? [{ pattern: declaration.name, factory }] : [];
  });
}

/** The Nimbus helper or agent factory a name in `sourceFile` refers to, through its imports and scopes. */
function nimbusNames(sourceFile: ts.SourceFile) {
  const checker = routeProgram(sourceFile).getTypeChecker();
  return {
    runtime: (node: ts.Expression) => importedName(checker, node, isRuntimeModule),
    agent: (node: ts.Expression) => importedName(checker, node, (specifier) => specifier === AGENT_MODULE),
  };
}

/** `export const getStaticPaths = <helper>(…)` statements, as the starter writes them. */
function helperPathsExports(code: string): { statement: ts.Statement; helper: StaticPathsHelper }[] {
  const sourceFile = parseRouteCode(code);
  const { runtime } = nimbusNames(sourceFile);
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
    const [declaration, ...rest] = statement.declarationList.declarations;
    if (rest.length || !declaration || !ts.isIdentifier(declaration.name) || declaration.name.text !== "getStaticPaths") return [];
    const value = declaration.initializer;
    const helper = value && helperIn(value, runtime);
    return helper ? [{ statement, helper }] : [];
  });
}

function helperIn(value: ts.Expression, runtime: (node: ts.Expression) => string | undefined): StaticPathsHelper | undefined {
  if (!ts.isCallExpression(value)) {
    const name = runtime(value);
    return isStaticPathsHelper(name) && !takesCollection(name) ? name : undefined;
  }
  const name = runtime(value.expression);
  const [collection] = value.arguments;
  return isStaticPathsHelper(name) && takesCollection(name) && collection && ts.isStringLiteralLike(collection) ? name : undefined;
}

/**
 * The `getStaticPaths` a built page route needs. An API route's options
 * (`{ homeChunkSize }`) go to both helpers, so it takes the ones its page
 * helper passes, when they use only imports and exported constants: Astro
 * runs `getStaticPaths` apart from the rest of the file.
 */
function builtStaticPaths(
  page: NonNullable<RouteFileTarget["page"]>,
  code: string,
): { value: string; reads: Set<string> } | { todo: string } {
  const paths = staticPathsFor(page.collection, page.kind);
  if (page.kind !== "api") return { value: paths, reads: new Set() };
  const calls = pageHelperCalls(code).map(helperArguments);
  if (calls.some((call) => call.named === undefined))
    return { todo: `Its page helper's arguments aren't a collection name and options Nimbus can read. Add \`export const getStaticPaths = ${paths};\`, passing the page helper's options too.` };
  const options = calls.find((call) => call.options)?.options;
  if (!options) return { value: paths, reads: new Set() };
  const value = `${paths.slice(0, -1)}, ${options.getText()})`;
  const { reads, hidden, inner } = namesRead(options);
  const list = (names: Set<string>) => [...names].map((name) => `\`${name}\``).join(", ");
  if (inner.size > 0)
    return {
      todo:
        `Its page helper's options read ${list(inner)} from inside the page, which getStaticPaths can't see: Astro runs it apart from the rest of the file. ` +
        `Add \`export const getStaticPaths = ${paths.slice(0, -1)}, …);\` with the options the page helper gets.`,
    };
  if (hidden.size === 0) return { value, reads };
  const names = list(hidden);
  return {
    todo:
      `Its page helper's options read ${names}, which getStaticPaths can't see: Astro runs it apart from the rest of the file. ` +
      `Export ${hidden.size === 1 ? "it" : "them"} (\`export const ${[...hidden][0]} = …\`), then run check --fix again.`,
  };
}

/**
 * The names `node` reads, resolved through the checker: `reads` are exported
 * top-level constants, which `getStaticPaths` can see; `hidden` are other
 * top-level names, which it can't until they're exported; `inner` are names
 * declared inside the page, such as a parameter. Imports, globals and names
 * declared inside the expression itself are none of these.
 */
function namesRead(node: ts.Node): { reads: Set<string>; hidden: Set<string>; inner: Set<string> } {
  const sourceFile = node.getSourceFile();
  const checker = routeProgram(sourceFile).getTypeChecker();
  const reads = new Set<string>();
  const hidden = new Set<string>();
  const inner = new Set<string>();
  const within = (inner: ts.Node, outer: ts.Node) => inner.pos >= outer.pos && inner.end <= outer.end;
  const walk = (root: ts.Node) => {
    const visit = (child: ts.Node): void => {
      // Types aren't values getStaticPaths reads, as in `satisfies ApiHomeOptions`.
      if (ts.isTypeNode(child)) return;
      const parent = child.parent;
      const isName = (ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent)) && parent.name === child;
      if (ts.isIdentifier(child) && !isName) {
        const symbol = ts.isShorthandPropertyAssignment(parent)
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(child);
        const declaration = symbol?.declarations?.[0];
        if (declaration && !within(declaration, root) && !isValueImport(declaration)) {
          if (!isTopLevel(declaration, sourceFile)) inner.add(child.text);
          else if (!isExportedConst(declaration, sourceFile)) hidden.add(child.text);
          else if (!reads.has(child.text)) {
            // An exported constant is only as visible as the names it reads.
            reads.add(child.text);
            if (declaration.initializer) walk(declaration.initializer);
          }
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(root);
  };
  walk(node);
  return { reads, hidden, inner };
}

function isTopLevel(declaration: ts.Declaration, sourceFile: ts.SourceFile): boolean {
  const statement = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
  return statement.parent === sourceFile;
}

function isValueImport(declaration: ts.Declaration): boolean {
  if (ts.isImportSpecifier(declaration)) return !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly;
  if (ts.isNamespaceImport(declaration)) return !declaration.parent.isTypeOnly;
  return ts.isImportClause(declaration) && !declaration.isTypeOnly;
}

function isExportedConst(declaration: ts.Declaration, sourceFile: ts.SourceFile): declaration is ts.VariableDeclaration {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const list = declaration.parent;
  const statement = list.parent;
  return (
    ts.isVariableStatement(statement) &&
    statement.parent === sourceFile &&
    (list.flags & ts.NodeFlags.Const) !== 0 &&
    (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

/**
 * What a page helper is passed after `Astro`: whether it names the collection
 * (a string, or a top-level const holding one), and its options (an object, or
 * a const holding one). `named` is `undefined` when Nimbus can't tell.
 */
function helperArguments(call: ts.CallExpression): { named?: boolean; options?: ts.Expression } {
  const [, second, third] = call.arguments;
  if (!second) return { named: false };
  const kind = valueKind(second);
  if (kind === "string") return { named: true, ...(third ? { options: third } : {}) };
  if (kind === "object" && !third) return { named: false, options: second };
  return {};
}

function valueKind(node: ts.Expression, depth = 0): "string" | "object" | undefined {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  if (ts.isStringLiteralLike(node)) return "string";
  if (ts.isObjectLiteralExpression(node)) return "object";
  if (!ts.isIdentifier(node) || depth > 8) return undefined;
  for (const statement of node.getSourceFile().statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of statement.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.name.text === node.text && d.initializer) return valueKind(d.initializer, depth + 1);
  }
  return undefined;
}

function pageHelperCalls(code: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const sourceFile = parseRouteCode(code);
  const { runtime } = nimbusNames(sourceFile);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && PAGE_HELPERS.has(runtime(node.expression) ?? "")) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}


/**
 * Remove a node of `code`'s own parse, and its line once nothing else is on
 * it, with a blank line that leaves doubled.
 */
function removeNode(code: string, node: ts.Node): string {
  const at = node.getStart();
  const to = node.getEnd();
  const start = code.lastIndexOf("\n", at - 1) + 1;
  const newline = code.indexOf("\n", to);
  const end = newline === -1 ? code.length : newline;
  if ((code.slice(start, at) + code.slice(to, end)).trim() !== "") return code.slice(0, at) + code.slice(to).replace(/^[ \t]+/u, "");
  const before = code.slice(0, start);
  let after = code.slice(newline === -1 ? end : end + 1);
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
  const last = parseRouteCode(code).statements.filter(ts.isImportDeclaration).at(-1);
  const newline = last ? code.indexOf("\n", last.getEnd()) : -1;
  const before = !last ? "" : newline === -1 ? `${code}\n` : code.slice(0, newline + 1);
  const rest = (last ? (newline === -1 ? "" : code.slice(newline + 1)) : code).replace(/^(?:[ \t]*\r?\n)+/u, "");
  const gap = rest === "" || /^export\s+const\s+(?:getStaticPaths\b|\{)/u.test(rest) ? "" : "\n";
  return `${before}${before ? "\n" : ""}${block}${gap}${rest}`;
}

/** Insert `line` after the last top-level statement declaring one of `names`, so it reads them once they're set. */
function insertAfterDeclarations(code: string, names: Set<string>, line: string): string {
  const last = parseRouteCode(code)
    .statements.filter(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && names.has(d.name.text)),
    )
    .at(-1)!;
  const newline = code.indexOf("\n", last.getEnd());
  return newline === -1 ? `${code}\n${line}\n` : `${code.slice(0, newline + 1)}${line}\n${code.slice(newline + 1)}`;
}

/** Remove a named runtime import nothing else references. */
function dropUnusedImport(code: string, name: string): string {
  const sourceFile = parseRouteCode(code);
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
    if (bindings.elements.length === 1) {
      // `import nimbus, { name }`: keep the default import.
      const fallback = statement.importClause?.name;
      return fallback ? `${code.slice(0, fallback.getEnd())} ${code.slice(bindings.getEnd()).trimStart()}` : removeNode(code, statement);
    }
    const next = bindings.elements[index + 1];
    const [from, to] = next ? [element.getStart(), next.getStart()] : [bindings.elements[index - 1]!.getEnd(), element.getEnd()];
    return code.slice(0, from) + code.slice(to);
  }
  return code;
}

/** Add `name` to the runtime import, or a new import after the last one. */
function addRuntimeImport(code: string, name: string): string {
  const sourceFile = parseRouteCode(code);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const imported = imports.some((statement) => {
    const bindings = statement.importClause?.namedBindings;
    return ts.isStringLiteral(statement.moduleSpecifier) && isRuntimeModule(statement.moduleSpecifier.text) && !statement.importClause?.isTypeOnly &&
      bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => !e.isTypeOnly && !e.propertyName && e.name.text === name);
  });
  if (imported) return code;
  for (const statement of imports) {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== RUNTIME) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.isTypeOnly) continue;
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
    if (call.arguments.length === 0 || helperArguments(call).named !== false) continue;
    const at = call.arguments[0]!.getEnd();
    out = `${out.slice(0, at)}, ${JSON.stringify(collection)}${out.slice(at)}`;
    const type = call.typeArguments?.length === 1 ? call.typeArguments[0]! : undefined;
    if (type && ts.isLiteralTypeNode(type)) out = out.slice(0, type.getStart() - 1) + out.slice(type.getEnd() + 1);
  }
  return out;
}
