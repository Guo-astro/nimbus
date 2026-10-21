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
  /** `prerender` is exported from an `export { … }` list, which Astro doesn't read as a mode. */
  listedPrerender: boolean;
  staticPaths: boolean;
}

/** A route's script: an `.astro` file's frontmatter, which opens the file, or the whole file. `undefined` for an `.astro` file with none. */
export function routeCode(file: string, source: string): RouteCode | undefined {
  if (!isAstroFile(file)) return { code: source, start: 0 };
  const frontmatter = /^(\s*---\r?\n)((?:[\s\S]*?\r?\n)?)---/u.exec(source);
  return frontmatter ? { code: frontmatter[2]!, start: frontmatter[1]!.length } : undefined;
}

export function parseRouteCode(code: string): ts.SourceFile {
  return ts.createSourceFile("route.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** A program over route code alone, with no lib or modules, so names resolve through the code's own scopes. */
export function routeProgram(sourceFile: ts.SourceFile): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext };
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(options),
    getSourceFile: (requested) => (requested === sourceFile.fileName ? sourceFile : undefined),
    fileExists: (requested) => requested === sourceFile.fileName,
    readFile: () => undefined,
  };
  return ts.createProgram({ rootNames: [sourceFile.fileName], options, host });
}

/**
 * The export a callee or value names, through a value import or namespace
 * import from a module `fromModule` accepts: `getApiRoute` for `apiRoute`
 * imported `as` it, or `api.getApiRoute`. `undefined` for anything else,
 * such as a parameter that shadows the import.
 */
export function importedName(checker: ts.TypeChecker, node: ts.Expression, fromModule: (specifier: string) => boolean): string | undefined {
  const from = (statement: ts.ImportDeclaration | ts.JSDocImportTag) =>
    !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier) && fromModule(statement.moduleSpecifier.text);
  const declarationOf = (name: ts.Node) => checker.getSymbolAtLocation(name)?.declarations?.[0];
  if (ts.isIdentifier(node)) {
    const declaration = declarationOf(node);
    return declaration && ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && from(declaration.parent.parent.parent)
      ? (declaration.propertyName ?? declaration.name).text
      : undefined;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const declaration = declarationOf(node.expression);
    return declaration && ts.isNamespaceImport(declaration) && from(declaration.parent.parent) ? node.name.text : undefined;
  }
  return undefined;
}

/**
 * `namedExports` counts `export { getStaticPaths }` and re-exports, which a
 * `.ts` endpoint can use but `.astro` frontmatter can't.
 */
export function readRouteExports(sourceFile: ts.SourceFile, namedExports = false): RouteExports {
  const prerenders: PrerenderExport[] = [];
  let staticPaths = namedExports && exportedNames(sourceFile).has("getStaticPaths");
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
  const listedPrerender = !prerenders.length && exportedNames(sourceFile).has("prerender");
  return { prerenders, listedPrerender, staticPaths };
}

/** A route file's exports: none for an `.astro` file without frontmatter. */
export function readRouteFileExports(file: string, source: string): RouteExports {
  const script = routeCode(file, source);
  return script ? readRouteExports(parseRouteCode(script.code), !isAstroFile(file)) : { prerenders: [], listedPrerender: false, staticPaths: false };
}

export function isAstroFile(file: string): boolean {
  return file.endsWith(".astro");
}

/** Every name the code exports, from declarations and `export { … }` lists. */
export function exportedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) for (const element of clause.elements) names.add(element.name.text);
      continue;
    }
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) for (const name of boundNames(declaration.name)) names.add(name);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
  }
  return names;
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
