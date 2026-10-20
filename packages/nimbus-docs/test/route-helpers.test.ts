// The route reader and the route-file fixer know every page helper the runtime exports.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import ts from "typescript";

import { PAGE_HELPERS, STATIC_PATHS_HELPERS } from "../src/_internal/route-helpers.js";

const runtime = ts.createSourceFile(
  "runtime.ts",
  fs.readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
);
const exported = new Set(
  runtime.statements.flatMap((statement) => {
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
    if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text];
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
    return [];
  }),
);

test("every page-route static-paths helper has a row", () => {
  assert.deepEqual(
    [...exported].filter((name) => /^get\w*StaticPaths$/u.test(name)).sort(),
    Object.keys(STATIC_PATHS_HELPERS).sort(),
  );
});

test("every page helper is a runtime export", () => {
  for (const helper of PAGE_HELPERS) assert.ok(exported.has(helper), helper);
});
