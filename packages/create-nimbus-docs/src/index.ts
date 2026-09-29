/**
 * `create-nimbus-docs` — CLI entry.
 *
 * Usage:
 *   create-nimbus-docs [dir] [flags]
 *
 * Flags:
 *   --deploy <target>      Static-output deploy target (cloudflare|other).
 *   --adapter <id>         Server-output adapter; selects `output: "server"`.
 *   --yes, -y              Use defaults, skip prompts.
 *   --skip-install         Don't run package-manager install after scaffold.
 *   --package-manager <pm> Package manager (npm|pnpm|yarn|bun). Auto-detected if omitted.
 *   --git, --no-git        Initialize a git repository, or don't.
 *   --template-dir <path>  Scaffold from a local template directory (offline).
 *   --help, -h
 *   --version, -v
 */

import * as p from "@clack/prompts";
import mri from "mri";
import { scaffold, ScaffoldError, type ScaffoldResult } from "./scaffold.js";
import {
  getPromptResponses,
  ADAPTER_IDS,
  type AdapterId,
  type ContentMode,
  type PackageManager,
} from "./prompts.js";

/** Print a one-line message and exit nonzero — never leak a raw stack. */
function die(message: string): never {
  p.log.error(message);
  process.exit(1);
}

// Safety net for anything that escapes the explicit try/catch below (e.g. a
// rejection deep in a dependency). A CLI should fail with a sentence, not a
// stack trace.
process.on("unhandledRejection", (reason) =>
  die(reason instanceof Error ? reason.message : String(reason)),
);
process.on("uncaughtException", (err) => die(err.message));

declare const __APP_VERSION__: string;
declare const __MIN_NODE_VERSION__: string;

const BOOLEAN_FLAGS = ["yes", "help", "version", "skip-install", "git"];
const STRING_FLAGS = ["package-manager", "deploy", "adapter", "content", "template-dir"];
const SHORT_FLAGS: Record<string, string> = { y: "yes", h: "help", v: "version" };
const argv = process.argv.slice(2);
// npm needs `--` before the arguments, and pnpm passes a leading one through
// (`pnpm dlx … -- my-docs --yes`); after it mri reads every flag as a name.
if (argv[0] === "--") argv.shift();

// mri accepts any flag, so a typo or a flag from another tool would be
// silently ignored and scaffold something else. Refuse it instead.
const booleanValues = new Map<string, Set<boolean>>();
const record = (name: string, on: boolean) => booleanValues.set(name, (booleanValues.get(name) ?? new Set()).add(on));
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  if (token === "--") break;
  if (!token.startsWith("-") || token === "-") continue;
  const long = token.startsWith("--");
  const [name = "", value] = token.slice(long ? 2 : 1).split(/=(.*)/s);
  const bare = name.replace(/^no-/, "");
  const known = long
    ? BOOLEAN_FLAGS.includes(bare) || STRING_FLAGS.includes(name)
    : [...name].every((char) => char in SHORT_FLAGS);
  if (!known) {
    die(
      `Unknown flag ${long ? "--" : "-"}${name}. Valid flags: ` +
        [...STRING_FLAGS, ...BOOLEAN_FLAGS, "no-git"].map((flag) => `--${flag}`).join(", ") +
        `, and -y, -h, -v. Run create-nimbus-docs --help for details.`,
    );
  }
  if (long && BOOLEAN_FLAGS.includes(bare)) {
    // Like mri, read a following `true` or `false` as the flag's value.
    const next = argv[i + 1];
    const explicit = value ?? (name === bare && (next === "true" || next === "false") ? argv[++i] : undefined);
    record(bare, (explicit !== "false") !== (name !== bare));
  } else if (!long) {
    for (const char of name) record(SHORT_FLAGS[char]!, true);
  }
}
for (const [name, values] of booleanValues) {
  if (values.size > 1) die(`--${name} and --no-${name} contradict each other. Pass one.`);
}

const args = mri(argv, {
  boolean: BOOLEAN_FLAGS,
  string: STRING_FLAGS,
  alias: SHORT_FLAGS,
});

if (args._.length > 1) {
  die(`Unexpected argument ${JSON.stringify(String(args._[1]))}. Pass one directory, then flags.`);
}

if (args.help) {
  console.log(`
  Usage: create-nimbus-docs [dir] [flags]

  Arguments:
    dir                    Project directory (default: prompted, my-docs)

  Flags:
    --deploy <target>      cloudflare | other (default: cloudflare) — static output
    --adapter <id>         ${ADAPTER_IDS.join(" | ")} — server output
    --content <mode>       starter | empty   (default: starter)
    --yes, -y              Use defaults for everything
    --skip-install         Skip dependency install
    --package-manager <pm> npm | pnpm | yarn | bun (default: the one running this)
    --git, --no-git        Initialize git, or skip it
    --template-dir <path>  Scaffold from a local template directory (no network)
    --help, -h
    --version, -v
`);
  process.exit(0);
}

if (args.version) {
  console.log(__APP_VERSION__);
  process.exit(0);
}

const [nodeMajor] = process.versions.node.split(".");
const [minMajor] = __MIN_NODE_VERSION__.split(".");
if (Number(nodeMajor) < Number(minMajor)) {
  console.error(
    `create-nimbus-docs requires Node ${__MIN_NODE_VERSION__} or later. You are running ${process.versions.node}.`,
  );
  process.exit(1);
}

p.intro("Create a Nimbus docs site");

const DEPLOY_TARGETS = ["cloudflare", "other"] as const;
const deploy = args.deploy as string | undefined;
if (deploy !== undefined && !DEPLOY_TARGETS.includes(deploy as (typeof DEPLOY_TARGETS)[number])) {
  die(`Unknown deploy target "${deploy}". Expected one of: ${DEPLOY_TARGETS.join(", ")}.`);
}

const adapter = args.adapter as string | undefined;
if (adapter !== undefined && !ADAPTER_IDS.includes(adapter as AdapterId)) {
  die(`Unknown adapter "${adapter}". Expected one of: ${ADAPTER_IDS.join(", ")}.`);
}
const CONTENT_MODES = ["starter", "empty"] as const;
const content = args.content as string | undefined;
if (content !== undefined && !CONTENT_MODES.includes(content as ContentMode)) {
  die(`Unknown content "${content}". Expected one of: ${CONTENT_MODES.join(", ")}.`);
}

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
const packageManager = args["package-manager"] as string | undefined;
if (packageManager !== undefined && !PACKAGE_MANAGERS.includes(packageManager as PackageManager)) {
  die(`Unknown package manager "${packageManager}". Expected one of: ${PACKAGE_MANAGERS.join(", ")}.`);
}

// `--deploy` picks a static site's target and `--adapter` makes a server
// site, so together they ask for two different sites.
if (adapter !== undefined && deploy !== undefined) {
  die(`--deploy and --adapter can't be combined: --deploy sets a static site's target, --adapter makes a server site. Pass one.`);
}

const responses = await getPromptResponses({
  // mri turns a numeric positional after a boolean flag (`--yes 2026`) into a number.
  dir: args._[0] === undefined ? undefined : String(args._[0]),
  yes: args.yes,
  skipInstall: args["skip-install"],
  deploy: deploy as "cloudflare" | "other" | undefined,
  adapter: adapter as AdapterId | undefined,
  content: content as ContentMode | undefined,
  packageManager: packageManager as PackageManager | undefined,
  git: args.git,
});

let result: ScaffoldResult;
try {
  result = await scaffold({ ...responses, templateDir: args["template-dir"] });
} catch (err) {
  if (err instanceof ScaffoldError) die(err.message);
  // Unexpected failure — surface a one-liner, not a stack trace.
  die(`Something went wrong while scaffolding: ${(err as Error).message}`);
}

const { packageManager: pm } = responses;
const nextSteps = [
  `cd ${shellArg(responses.dir)}`,
  ...(result.install === "done" ? [] : [`${pm} install`]),
  `${pm === "yarn" ? "yarn" : `${pm} run`} dev`,
].map((step) => `    ${step}`);

if (result.install === "failed") {
  // The project is usable once installed, so keep it and say how; the exit
  // code tells CI the site isn't ready.
  p.log.error(`Created the project in ${responses.dir}, but installing dependencies failed. To finish:\n\n${nextSteps.join("\n")}`);
  process.exit(1);
}

p.outro(`
  Done. Next steps:

${nextSteps.join("\n")}
`);

function shellArg(value: string): string {
  const path = value.startsWith("-") ? `./${value}` : value;
  if (/^[A-Za-z0-9_./-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}
