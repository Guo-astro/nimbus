/**
 * Component / utility installer.
 *
 * Walks the resolved list of items, writes each file (per-file overwrite
 * prompt on conflict), then collects all npm `dependencies` across the
 * tree and runs `<pm> add` once for the dedup'd set.
 *
 * File destination: `<cwd>/src/<path>`. The `path` field already encodes
 * the directory layout (e.g. `components/ui/dialog/Dialog.astro`).
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import * as p from "@clack/prompts";

import { componentsMapBody } from "../_internal/parse-components-registry.js";
import { stripComments, stripStrings } from "../_internal/parse-object-literal.js";
import { readTreeFile, resolveTemplateTree, type FetchedTree } from "./_templates.js";
import { bytesHash, type NimbusJson } from "./nimbus-json.js";
import { addCommand, detectPackageManager } from "./pm.js";
import { progress } from "./progress.js";
import type { ComponentItem } from "./resolver.js";
import { starterProjectPath } from "./upgrade.js";

export interface InstallOptions {
  /** User's project root. */
  cwd: string;
  /** The upgrade verb: replace every conflicting file in the tree, no prompt. */
  overwrite: boolean;
  /** Non-interactive assent (dep install etc.); conflict default is to KEEP the
   * user's file (never clobber). `--overwrite` is the way to replace. */
  yes: boolean;
  /** Src dir to write against, relative to `cwd` (default `"src"`; monorepo root from nimbus.json). */
  srcRoot?: string;
  /** Each installed slug's record in nimbus.json, to tell local edits from upstream changes. */
  recorded?: ReadonlyMap<string, { hash: string | null; files: readonly string[] }>;
  /** The starter release the site came from, to tell edits on components it shipped. */
  starter?: StarterBaseline | null;
}

export interface InstallReport {
  /** Individual files actually written (new or replaced). */
  written: string[];
  /** Existing files whose content was replaced. */
  replaced: string[];
  /** Registry slugs already identical to the registry: nothing written. */
  upToDate: string[];
  /** Registry slugs whose differing files were kept. */
  skipped: string[];
  /** The kept files that differ from the registry. */
  kept: string[];
  npmDepsInstalled: string[];
}

export async function installComponents(
  items: ComponentItem[],
  options: InstallOptions,
): Promise<InstallReport> {
  const report: InstallReport = {
    written: [],
    replaced: [],
    upToDate: [],
    skipped: [],
    kept: [],
    npmDepsInstalled: [],
  };

  // ---- 1. Write files — atomic per registry item -------------------------
  //
  // Each item (e.g. `dialog`) is treated as an indivisible unit: when any
  // of its files conflict, we prompt once for the whole slug. Letting users
  // overwrite Dialog.astro while keeping DialogContent.astro is a footgun
  // — components are cohesive and meant to evolve together.
  const srcDir = join(options.cwd, options.srcRoot ?? "src");

  // Security: registry payloads are untrusted (see resolver.ts). Validate
  // every path across every item before any write, so a traversal entry
  // can't escape src/ or land a partial install.
  for (const item of items) {
    for (const file of item.files) {
      assertInsideSrc(srcDir, file.path, item.name);
    }
  }

  for (const item of items) {
    const filePlans = item.files.map((file) => {
      const targetAbs = resolve(srcDir, file.path);
      return {
        targetAbs,
        targetRel: relative(options.cwd, targetAbs),
        content: file.content,
        exists: existsSync(targetAbs),
        path: file.path,
      };
    });
    const onDisk = new Map(
      filePlans.filter((f) => f.exists).map((f) => [f.targetAbs, readFileSync(f.targetAbs, "utf8")] as const),
    );

    // Only files that differ from the registry are conflicts; identical ones
    // are already installed.
    const conflicts = filePlans.filter((f) => f.exists && onDisk.get(f.targetAbs) !== f.content);
    const missing = filePlans.filter((f) => !f.exists);
    if (conflicts.length === 0 && missing.length === 0) {
      report.upToDate.push(item.name);
      continue;
    }

    // `--overwrite` replaces every conflicting file across the tree — the
    // explicit upgrade path. Without it we never clobber an owned file.
    // Missing files are always written; declining only keeps existing ones.
    let keep = false;
    const edits =
      conflicts.length > 0 && options.overwrite && !options.yes && process.stdin.isTTY
        ? await localEdits(options.recorded?.get(item.name), options.cwd, options.srcRoot ?? "src", {
            files: conflicts.map((f) => posix.join(options.srcRoot ?? "src", f.path)),
            baseline: options.starter ?? null,
          })
        : "none";
    if (edits !== "none") {
      // `--overwrite` replaces upstream changes freely, but asks before
      // discarding edits made since the item was installed.
      const replace = await p.confirm({
        message:
          `${item.name} ${edits === "edited" ? "has local edits" : "may have local edits (no install record)"}. ` +
          `Replace these files?\n${conflicts.map((f) => `  ${f.targetRel}`).join("\n")}`,
        initialValue: false,
      });
      if (p.isCancel(replace)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (!replace) keep = true;
    } else if (item.type === "registry:lib") {
      // Utilities (e.g. cn) are transitive deps users often customize — keep
      // their copy when present unless an explicit upgrade asks to replace it.
      if (conflicts.length > 0 && !options.overwrite) keep = true;
    } else if (conflicts.length > 0 && !options.overwrite) {
      // Non-interactive (or `--yes`): keep the user's files. `--yes` is assent
      // to prompts, not permission to clobber — `--overwrite` does that.
      if (options.yes || !process.stdin.isTTY) keep = true;

      const n = conflicts.length;
      const message = `${item.name}: ${n} file${n === 1 ? " differs" : "s differ"} from the registry. Overwrite ${n === 1 ? "it" : "them"}?`;

      const choice = keep ? "skip" : await p.select({
        message,
        options: [
          { value: "overwrite", label: "Overwrite — replace existing files" },
          { value: "skip", label: "Skip — leave files as-is" },
          { value: "cancel", label: "Cancel install" },
        ],
        initialValue: "skip",
      });

      if (p.isCancel(choice) || choice === "cancel") {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (choice === "skip") keep = true;
    }

    // Write what's new or different; identical files stay untouched.
    if (keep) {
      report.skipped.push(item.name);
      report.kept.push(...conflicts.map((f) => f.targetRel));
    }
    for (const plan of keep ? missing : [...missing, ...conflicts]) {
      mkdirSync(dirname(plan.targetAbs), { recursive: true });
      writeFileSync(plan.targetAbs, plan.content);
      report.written.push(plan.targetRel);
      if (plan.exists) report.replaced.push(plan.targetRel);
    }
  }

  // ---- 2. Install missing npm deps ---------------------------------------
  const allDeps = new Set<string>();
  for (const item of items) {
    for (const dep of item.dependencies) allDeps.add(dep);
  }

  if (allDeps.size > 0) {
    const newDeps = filterAlreadyInstalled(options.cwd, [...allDeps]);
    if (newDeps.length > 0) {
      const pm = detectPackageManager(options.cwd);
      const { bin, args } = addCommand(pm, newDeps);
      const spinner = progress();
      spinner.start(`${pm} add ${newDeps.join(" ")}`);
      try {
        await runCommand(bin, args, options.cwd);
        spinner.stop(
          `Installed ${newDeps.length} dep${newDeps.length === 1 ? "" : "s"}.`,
        );
        report.npmDepsInstalled = newDeps;
      } catch {
        spinner.stop("Dependency install failed.");
        p.log.warn(
          `Could not install ${newDeps.join(", ")}. Run \`${bin} ${args.join(" ")}\` manually.`,
        );
      }
    }
  }

  return report;
}

/**
 * Resolve `filePath` against `srcDir` and assert it stays strictly under it.
 * Throws on absolute paths or `..` traversal; returns the absolute target.
 * `resolve`-based (not raw-string), so `foo/../../bar` is normalized first.
 */
export function assertInsideSrc(
  srcDir: string,
  filePath: string,
  itemName: string,
): string {
  if (isAbsolute(filePath)) {
    throw new Error(
      `Refusing to install "${itemName}": registry file path "${filePath}" ` +
        `is absolute. Registry files must be relative to the project's src/ directory.`,
    );
  }

  const targetAbs = resolve(srcDir, filePath);
  if (!targetAbs.startsWith(srcDir + sep)) {
    throw new Error(
      `Refusing to install "${itemName}": registry file path "${filePath}" ` +
        `escapes the project's src/ directory (resolved to "${targetAbs}").`,
    );
  }

  assertResolvedInsideSrc(srcDir, targetAbs, filePath, itemName);

  return targetAbs;
}

function assertResolvedInsideSrc(
  srcDir: string,
  targetAbs: string,
  filePath: string,
  itemName: string,
): void {
  // A new `src/` directory cannot contain a link yet. Once it exists, resolve
  // the nearest existing target ancestor so writes cannot follow a link outside it.
  if (!existsSync(srcDir)) return;

  const realSrcDir = realpathSync(srcDir);
  let existing = targetAbs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return;
    existing = parent;
  }

  const realExisting = realpathSync(existing);
  const pathFromSrc = relative(realSrcDir, realExisting);
  if (
    pathFromSrc === ".." ||
    pathFromSrc.startsWith(`..${sep}`) ||
    isAbsolute(pathFromSrc)
  ) {
    throw new Error(
      `Refusing to install "${itemName}": registry file path "${filePath}" ` +
        "resolves outside the project's src/ directory through a symbolic link.",
    );
  }
}

/**
 * Whether a component was edited since it was installed. With an install
 * record, whether its files still hash to the recorded source; it compares the
 * installed set, not the registry's current one, so an upstream file added or
 * removed isn't mistaken for an edit. Without one, whether `starter.files`
 * match the starter release the site came from; a file the starter never
 * shipped doesn't count.
 */
export async function localEdits(
  record: { hash: string | null; files: readonly string[] } | undefined,
  cwd: string,
  srcRoot: string,
  starter?: { files: readonly string[]; baseline: StarterBaseline | null },
): Promise<"none" | "edited" | "unknown"> {
  if (record?.hash && record.files.length > 0) {
    const prefix = `${srcRoot.replace(/\/+$/, "")}/`;
    const files: { path: string; content: string }[] = [];
    for (const file of record.files) {
      if (!file.startsWith(prefix)) return "unknown";
      const abs = resolve(cwd, file);
      if (!existsSync(abs)) return "edited";
      files.push({ path: file.slice(prefix.length), content: readFileSync(abs, "utf8") });
    }
    return bytesHash(files) === record.hash ? "none" : "edited";
  }

  if (!starter?.baseline) return "unknown";
  let compared = 0;
  for (const file of starter.files) {
    let shipped: string | null;
    try {
      shipped = await starter.baseline.read(file);
    } catch {
      return "unknown"; // offline, or the release can't be fetched
    }
    if (shipped === null) continue;
    if (readFileSync(resolve(cwd, file), "utf8") !== shipped) return "edited";
    compared++;
  }
  return compared > 0 ? "none" : "unknown";
}

export interface StarterBaseline {
  /** A project file as the site's starter release shipped it, or null when it
   * shipped no such file. Rejects when the release can't be fetched. */
  read: (file: string) => Promise<string | null>;
  cleanup: () => void;
}

/**
 * The starter release a site was scaffolded from: each file at its
 * `templatesTagByFile` tag (taken with `diff --apply`), else `templatesTag`.
 * Null without a recorded tag (adopted with `init`, or a preview build). Each
 * tag is fetched once, on first read; `templateDir` reads a local tree instead.
 */
export function starterBaseline(
  nimbus: NimbusJson | null,
  srcRoot: string,
  templateDir?: string,
  resolveTree = (tag: string) => resolveTemplateTree({ variant: nimbus?.variant, tag, templateDir }),
): StarterBaseline | null {
  const recorded = nimbus?.templatesTag;
  if (!nimbus || !recorded) return null;
  const trees = new Map<string, Promise<FetchedTree>>();
  const fetched: FetchedTree[] = [];
  const tree = (tag: string) => {
    let pending = trees.get(tag);
    if (!pending) {
      pending = resolveTree(tag).then((t) => {
        fetched.push(t);
        return t;
      });
      trees.set(tag, pending);
    }
    return pending;
  };
  return {
    async read(file) {
      const treeFile = posix.join("src", posix.relative(srcRoot, file));
      if (treeFile.startsWith("src/..") || starterProjectPath(srcRoot, treeFile) !== file) return null;
      const { dir } = await tree(nimbus.templatesTagByFile?.[treeFile] ?? recorded);
      return readTreeFile(dir, treeFile);
    },
    cleanup() {
      for (const t of fetched.splice(0)) t.cleanup();
    },
  };
}

/**
 * Filter out deps already present in `dependencies` or `devDependencies`
 * of the user's package.json. If package.json is missing, returns all.
 */
function filterAlreadyInstalled(cwd: string, deps: string[]): string[] {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return deps;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    return deps.filter((d) => !installed.has(d));
  } catch {
    return deps;
  }
}

function runCommand(
  bin: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("close", (code) =>
      code === 0
        ? resolveP()
        : rejectP(new Error(`${bin} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", rejectP);
  });
}

// Named exports of a component's barrel (`components/ui/<slug>/index.ts`), for
// the "register in components.ts" hint after install.
function barrelExports(item: ComponentItem): string[] {
  const index = item.files.find((f) => f.path.endsWith(`/${item.name}/index.ts`));
  if (!index) return [];
  const names: string[] = [];
  for (const block of index.content.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (block[1] ?? "").split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const name = seg.includes(" as ") ? seg.split(" as ").pop()!.trim() : seg;
      if (/^[A-Za-z_]\w*$/.test(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The next step for the UI component the user asked for: the item's own
 * `docs` when it has one (a component that isn't used from `.mdx`), else the
 * "register in components.ts" hint. Its registry dependencies are installed
 * too but aren't meant to be registered, so they get no hint.
 */
/** components.ts imports the component and puts one of its imports in the `components` map as a value (not only a key). */
function isRegistered(registry: string, slug: string): boolean {
  const source = stripComments(registry);
  const path = `(?:\\./|@/)components/ui/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/index(?:\\.ts)?)?`;
  const clause = source.match(new RegExp(`import\\s+([^;'"]*?)\\s+from\\s*["']${path}["']`))?.[1];
  if (!clause) return false;
  const named = clause.match(/\{([^}]*)\}/)?.[1] ?? "";
  const locals = [
    ...named.split(",").map((part) => part.trim().split(/\s+as\s+/).pop()!.trim()),
    clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim().split(/\s+/)[0] ?? "",
  ].filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const body = componentsMapBody(registry);
  const map = body === null ? null : stripStrings(body);
  // An unreadable map can't prove the import is unused; trust the import.
  if (map === null) return locals.length > 0;
  // Identifiers used as values: shorthand entries and the right side of `Key: Value`.
  const values = new Set(map.match(/(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$])(?!\s*:)/g) ?? []);
  return locals.some((name) => values.has(name));
}

export function registerHint(
  installed: ComponentItem[],
  slug: string,
  srcRoot: string,
  registry = "",
): string | null {
  const item = installed.find((i) => i.type === "registry:ui" && i.name === slug);
  if (!item) return null;
  if (isRegistered(registry, item.name)) return null;
  if (item.docs) return item.docs;
  const names = barrelExports(item);
  const snippet = names.length > 0
    ? `  import { ${names.join(", ")} } from "./components/ui/${item.name}";  // then add ${names.join(", ")} to the map`
    : `  // ${item.name} — see ${srcRoot}/components/ui/${item.name}`;
  return `To use in .mdx, register in ${srcRoot}/components.ts — import and add to the \`components\` map:\n${snippet}`;
}
