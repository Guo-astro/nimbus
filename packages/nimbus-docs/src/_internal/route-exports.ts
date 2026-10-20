// What a route file exports about how it renders, read from its parsed code.
// One reader for the build, `check` and `check --fix`.

import ts from "typescript";

export interface RouteCode {
  code: string;
  /** Where `code` starts in the file: after an `.astro` file's opening fence. */
  start: number;
}

export interface PrerenderExport {
  statement: ts.VariableStatement;
  /** `true` or `false`, or `undefined` when set by an expression. */
  value?: boolean;
}

export interface RouteExports {
  prerenders: PrerenderExport[];
  staticPaths: boolean;
}

/** A route's script: an `.astro` file's frontmatter, or the whole file. `undefined` when the frontmatter can't be found. */
export function routeCode(file: string, source: string): RouteCode | undefined {
  if (!file.endsWith(".astro")) return { code: source, start: 0 };
  const frontmatter = /^(\s*---\r?\n)([\s\S]*?)(^---)/mu.exec(source);
  return frontmatter ? { code: frontmatter[2]!, start: frontmatter[1]!.length } : undefined;
}

export function parseRouteCode(code: string): ts.SourceFile {
  return ts.createSourceFile("route.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function readRouteExports(sourceFile: ts.SourceFile): RouteExports {
  const prerenders: PrerenderExport[] = [];
  let staticPaths = false;
  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "getStaticPaths") staticPaths = true;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const names = boundNames(declaration.name);
      if (names.includes("getStaticPaths")) staticPaths = true;
      if (!names.includes("prerender")) continue;
      const value = declaration.initializer && ts.isIdentifier(declaration.name) ? literal(declaration.initializer) : undefined;
      prerenders.push({ statement, ...(value === undefined ? {} : { value }) });
    }
  }
  return { prerenders, staticPaths };
}

/** A route file's exports; `undefined` when it has no readable script. */
export function readRouteFileExports(file: string, source: string): RouteExports | undefined {
  const script = routeCode(file, source);
  return script && readRouteExports(parseRouteCode(script.code));
}

function isExported(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)));
}

function literal(node: ts.Expression): boolean | undefined {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}
