/**
 * The **types** category: type-check the user's `.ts`/`.tsx` with their own
 * `tsc`, build-free (no `astro build`/`sync`, nothing spawned, `tsc` never
 * bundled). `tsc` can't parse `.astro` SFCs, so the ambient `declare module
 * "*.astro"` shim lets `.ts` files that import them resolve rather than
 * false-flag.
 *
 * Coverage is honest, and it is a *whole-scope* decision made from one fact:
 * does `.astro/types.d.ts` exist? Absent → the scope is `evaluated: false` (a
 * `○`, never a false green), because `astro:*` virtuals can't resolve without
 * it. Present → the scope is evaluated and **every** `ts/*` diagnostic is a real
 * finding, including an unresolved `astro:*` import (a stale artifact or a typo
 * like `astro:contennt`). A coverage gap must never blank an evaluated error,
 * so the old all-or-nothing `astro:*` bail is gone: independent errors survive.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type TS from "typescript";

import { dependenciesMissing } from "../_internal/upgrades.js";
import type { CheckFinding, ScopeReport } from "./finding.js";

export function checkTypes(cwd: string): ScopeReport {
  // The env scope reports the missing install; the tsconfig's `extends` and
  // `typescript` itself come from it.
  if (dependenciesMissing(cwd)) {
    return notEvaluated("dependencies aren't installed yet — skipping the type-check.");
  }
  if (!fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    return notEvaluated(
      "no `tsconfig.json` here — skipping the type-check. A scaffolded Nimbus project ships one; add it to enable this scope.",
    );
  }

  const ts = loadUserTypeScript(cwd);
  if (!ts) {
    return notEvaluated(
      "`typescript` isn't installed — skipping the type-check. Install it as a devDependency to enable this scope.",
    );
  }

  try {
    return runTsc(cwd, ts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return notEvaluated(
      `the type-check couldn't run (${detail}). env, structure, and authoring still ran.`,
    );
  }
}

function runTsc(cwd: string, ts: typeof TS): ScopeReport {
  // Parse tsconfig before the `.astro` gate — a malformed config is a real error
  // even pre-build, so it must not hide behind not_evaluated.
  const read = ts.readConfigFile(path.join(cwd, "tsconfig.json"), ts.sys.readFile);
  if (read.error) return evaluated([tsconfigInvalid(ts, read.error)]);

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, cwd);
  const configFindings = parsed.errors
    .filter((d) => d.code !== 18003)
    .map((d) => tsconfigInvalid(ts, d));
  if (configFindings.length > 0) return evaluated(configFindings);
  if (parsed.errors.some((d) => d.code === 18003)) {
    return notEvaluated(
      "no TypeScript sources matched `tsconfig.json` — nothing to type-check.",
    );
  }

  if (!fs.existsSync(path.join(cwd, ".astro", "types.d.ts"))) {
    return notEvaluated(
      "Astro's generated types (`.astro/types.d.ts`) don't exist yet — run a dev server or build once so `astro:content`/`astro:*` imports resolve, then the type-check runs. (env and structure are checked build-free.)",
      { requiresBuild: true },
    );
  }

  parsed.options.noEmit = true;
  const program = ts.createProgram({
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    rootNames: [...parsed.fileNames, astroShimName(cwd)],
    host: astroShimHost(ts, cwd, parsed.options),
  });

  const findings: CheckFinding[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const finding = toFinding(ts, cwd, d);
    if (finding) findings.push(finding);
  }
  return evaluated(findings);
}

function toFinding(ts: typeof TS, cwd: string, d: TS.Diagnostic): CheckFinding | null {
  let severity: CheckFinding["severity"];
  if (d.category === ts.DiagnosticCategory.Error) severity = "error";
  else if (d.category === ts.DiagnosticCategory.Warning) severity = "warn";
  else return null;

  const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
  const code = `ts/${d.code}`;

  if (!d.file) {
    return { scope: "types", code, severity, file: "tsconfig.json", message, fixable: false };
  }

  const rel = path.relative(cwd, d.file.fileName);
  const segments = rel.split(path.sep);
  if (
    rel.startsWith("..") ||
    segments.includes("node_modules") ||
    segments[0] === ".astro" ||
    segments[segments.length - 1] === SHIM_BASENAME
  ) {
    return null;
  }

  const pos =
    d.start === undefined ? undefined : d.file.getLineAndCharacterOfPosition(d.start);
  return {
    scope: "types",
    code,
    severity,
    file: segments.join("/"),
    ...(pos ? { line: pos.line + 1, column: pos.character + 1 } : {}),
    message,
    fixable: false,
  };
}

const SHIM_BASENAME = "__nimbus-astro-shim__.d.ts";
const astroShimName = (cwd: string): string => path.join(cwd, SHIM_BASENAME);
const ASTRO_SHIM_TEXT =
  'declare module "*.astro" { const component: any; export default component; }\n';

function astroShimHost(
  ts: typeof TS,
  cwd: string,
  options: TS.CompilerOptions,
): TS.CompilerHost {
  const shim = astroShimName(cwd);
  const host = ts.createCompilerHost(options, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    if (fileName === shim) {
      return ts.createSourceFile(fileName, ASTRO_SHIM_TEXT, languageVersionOrOptions, true);
    }
    return baseGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
  };
  host.fileExists = (fileName) => (fileName === shim ? true : baseFileExists(fileName));
  host.readFile = (fileName) => (fileName === shim ? ASTRO_SHIM_TEXT : baseReadFile(fileName));
  return host;
}

function evaluated(findings: CheckFinding[]): ScopeReport {
  return { scope: "types", findings, notes: [], evaluated: true };
}

function notEvaluated(
  reason: string,
  opts: { requiresBuild?: boolean } = {},
): ScopeReport {
  return {
    scope: "types",
    findings: [],
    notes: [{ code: "nimbus/types-not-evaluated", reason, ...opts }],
    evaluated: false,
    reason,
  };
}

function tsconfigInvalid(ts: typeof TS, d: TS.Diagnostic): CheckFinding {
  return {
    scope: "types",
    code: "nimbus/tsconfig-invalid",
    severity: d.category === ts.DiagnosticCategory.Warning ? "warn" : "error",
    file: "tsconfig.json",
    message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    fixable: false,
  };
}

function loadUserTypeScript(cwd: string): typeof TS | null {
  try {
    const require = createRequire(path.join(cwd, "package.json"));
    return require(require.resolve("typescript")) as typeof TS;
  } catch {
    return null;
  }
}
