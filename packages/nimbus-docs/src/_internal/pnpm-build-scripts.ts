/**
 * pnpm runs a dependency's build script only once the project decides on it.
 * pnpm 11 keeps the decision in `pnpm-workspace.yaml`'s `allowBuilds` map and
 * fails an install that meets an undecided one (`ERR_PNPM_IGNORED_BUILDS`),
 * writing a `<name>: set this to true or false` placeholder; pnpm 10 reads
 * the `ignoredBuiltDependencies` list. Nimbus declines the scripts it knows a
 * site doesn't need (workerd's, pulled in by wrangler), in the file pnpm reads.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const PLACEHOLDER = "set this to true or false";

/** The `pnpm-workspace.yaml` pnpm reads for `cwd`: its own, else the nearest ancestor's. */
export function pnpmWorkspaceFile(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = join(dir, WORKSPACE_FILE);
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Decline `name`'s build script in `file`, creating the file when it doesn't
 * exist. A decision already made (`true` or `false`) is kept, and so is a file
 * that isn't valid YAML or whose `allowBuilds` isn't a map. Returns whether
 * the file changed.
 */
export function declineBuildScript(file: string, name: string): boolean {
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  // A new file carries all three keys, as the starter's does: pnpm 9 requires
  // `packages`, pnpm 10 reads `ignoredBuiltDependencies`, pnpm 11 `allowBuilds`.
  if (!original.trim()) {
    return write(file, `packages: []\nallowBuilds: # pnpm 11\n  ${name}: false\nignoredBuiltDependencies: # pnpm 10\n  - ${name}\n`);
  }
  const doc = parseDocument(original);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return false;

  let changed = false;
  const allow = doc.get("allowBuilds", true);
  if (allow !== undefined && !isMap(allow)) return false;
  const decision = doc.getIn(["allowBuilds", name]);
  // The site allowed it: that's its call, in both lists.
  if (decision === true) return false;
  if (decision === undefined || decision === null || decision === PLACEHOLDER) {
    doc.setIn(["allowBuilds", name], false);
    changed = true;
  }
  // pnpm 10 reads only this list, and fails an unreviewed script under `strictDepBuilds`.
  const ignored = doc.get("ignoredBuiltDependencies", true);
  if (ignored === undefined) {
    doc.set("ignoredBuiltDependencies", doc.createNode([name]));
    changed = true;
  } else if (isSeq(ignored) && !ignored.items.some((item) => (isScalar(item) ? item.value : item) === name)) {
    ignored.add(doc.createNode(name));
    changed = true;
  }
  if (!changed) return false;
  // The yaml library re-emits a comment after `allowBuilds:` on a line of its
  // own; keep it on the key's line, where the file has it.
  for (const key of ["allowBuilds", "ignoredBuiltDependencies"]) {
    const pair = doc.contents.items.find((item) => isScalar(item.key) && item.key.value === key);
    const value = pair?.value as { commentBefore?: string | null } | null | undefined;
    if (pair && isScalar(pair.key) && value?.commentBefore && new RegExp(`^${key}:[ \\t]*#`, "m").test(original)) {
      pair.key.comment = value.commentBefore;
      value.commentBefore = undefined;
    }
  }
  return write(file, doc.toString({ indent: indentOf(original), indentSeq: !/^- /m.test(original) }));
}

/** Atomic: a write cut short must not leave pnpm a half-written workspace file. */
function write(file: string, text: string): true {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
  return true;
}

/** The file's indentation step: its least-indented nested line, else 2. */
function indentOf(text: string): number {
  const widths = [...text.matchAll(/^( +)[^ #\n]/gm)].map((match) => match[1]!.length);
  return widths.length > 0 ? Math.min(...widths) : 2;
}
