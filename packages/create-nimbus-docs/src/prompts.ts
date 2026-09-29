import * as p from "@clack/prompts";
import { ADAPTER_RECIPES, type AdapterId } from "@cloudflare/nimbus-docs/adapters";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type DeployTarget = "cloudflare" | "other";
export type ContentMode = "starter" | "empty";
export type OutputMode = "static" | "server";
export type { AdapterId };

/** The known adapter ids, derived from the framework's recipe table. */
export const ADAPTER_IDS = Object.keys(ADAPTER_RECIPES) as AdapterId[];

// Interactive scaffolding currently supports the Cloudflare adapter.
export const INTERACTIVE_ADAPTER_OPTIONS = [
  { value: "cloudflare", label: "Cloudflare" },
] satisfies Array<{ value: AdapterId; label: string }>;

export interface PromptOptions {
  dir?: string;
  /** Static-lane deploy target. Ignored once an adapter selects the server lane. */
  deploy?: DeployTarget;
  /** Server-lane adapter. Its presence selects `output: "server"`. */
  adapter?: AdapterId;
  content?: ContentMode;
  yes?: boolean;
  skipInstall?: boolean;
  packageManager?: PackageManager;
  git?: boolean;
}

interface ResponsesBase {
  dir: string;
  content: ContentMode;
  packageManager: PackageManager;
  git: boolean;
  skipInstall: boolean;
}

/**
 * Output mode is primary; the target derives from it. A discriminated union
 * makes `static + adapter` and `server + deploy` unrepresentable, so there is
 * no runtime conflict rule to get wrong.
 */
export type PromptResponses =
  | (ResponsesBase & { output: "static"; deploy: DeployTarget })
  | (ResponsesBase & { output: "server"; adapter: AdapterId });

function detectPackageManager(): PackageManager {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("bun")) return "bun";
  return "npm";
}

export async function getPromptResponses(opts: PromptOptions): Promise<PromptResponses> {
  const defaultPM = opts.packageManager ?? detectPackageManager();

  if (opts.yes) {
    const base: ResponsesBase = {
      dir: opts.dir ?? "my-docs",
      content: opts.content ?? "starter",
      packageManager: defaultPM,
      git: opts.git ?? true,
      skipInstall: opts.skipInstall ?? false,
    };
    // An adapter selects the server lane; otherwise `--yes` defaults to static.
    return opts.adapter
      ? { ...base, output: "server", adapter: opts.adapter }
      : { ...base, output: "static", deploy: opts.deploy ?? "cloudflare" };
  }

  // Interactive mode. Without a terminal no prompt can run, so name every
  // unanswered question and its flag at once rather than one per run.
  if (!process.stdin.isTTY) {
    const unanswered = [
      opts.dir === undefined && `Where should we create your project? Pass a directory argument.`,
      opts.content === undefined && `Starter content? Pass --content starter|empty.`,
      opts.packageManager === undefined && `Which package manager? Pass --package-manager npm|pnpm|yarn|bun.`,
      opts.git === undefined && `Initialize a git repository? Pass --git or --no-git.`,
      opts.adapter === undefined &&
        opts.deploy === undefined &&
        `Output mode? Pass --deploy cloudflare|other (static) or --adapter cloudflare (server).`,
    ].filter((line): line is string => typeof line === "string");
    if (unanswered.length > 0) {
      p.log.error(
        `No terminal to ask ${unanswered.length === 1 ? "this question" : "these questions"}. ` +
          `Answer with flags, or pass --yes to accept the defaults:\n` +
          unanswered.map((line) => `  - ${line}`).join("\n"),
      );
      process.exit(1);
    }
  }

  const dir =
    opts.dir ??
    (await ask(() =>
      p.text({
        message: "Where should we create your project?",
        placeholder: "my-docs",
        // Enter accepts the placeholder. clack validates before applying the
        // default, so an empty answer has to pass.
        defaultValue: "my-docs",
        validate: (value) => {
          if (!value) return undefined;
          // Reject absolute paths early — `path.resolve(cwd, "/foo")`
          // ignores cwd and lands at the filesystem root, which then
          // fails with EROFS on macOS/Linux. Prompt the user to drop
          // the leading slash and try again.
          if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) {
            return "Use a relative path (e.g. `my-docs` or `./my-docs`), not an absolute path.";
          }
          return undefined;
        },
      }),
    ));

  const content =
    opts.content ??
    ((await ask(() =>
      p.select({
        message: "Starter content?",
        options: [
          {
            value: "starter",
            label: "Getting started guide + example pages",
          },
          { value: "empty", label: "Empty — just the shell" },
        ],
        initialValue: "starter",
      }),
    )) as ContentMode);

  const packageManager =
    opts.packageManager ??
    ((await ask(() =>
      p.select({
        message: "Which package manager?",
        options: [
          { value: "npm", label: "npm" },
          { value: "pnpm", label: "pnpm" },
          { value: "yarn", label: "yarn" },
          { value: "bun", label: "bun" },
        ],
        initialValue: defaultPM,
      }),
    )) as PackageManager);

  const git =
    opts.git ??
    (await ask(() =>
      p.confirm({
        message: "Initialize a git repository?",
        initialValue: true,
      }),
    ));

  const base: ResponsesBase = {
    dir,
    content,
    packageManager,
    git,
    skipInstall: opts.skipInstall ?? false,
  };

  // Server lane if an adapter was passed; static lane if a deploy target was.
  // Otherwise ask output mode, then the target that mode implies.
  if (opts.adapter) return { ...base, output: "server", adapter: opts.adapter };
  if (opts.deploy) return { ...base, output: "static", deploy: opts.deploy };

  const output = (await ask(() =>
    p.select({
      message: "Output mode?",
      options: [
        { value: "static", label: "Static (default) — prerendered, deploy anywhere" },
        { value: "server", label: "Server — enable on-demand routes (adds an adapter)" },
      ],
      initialValue: "static",
    }),
  )) as OutputMode;

  if (output === "server") {
    const adapter = (await ask(() =>
      p.select({
        message: "Which adapter?",
        options: INTERACTIVE_ADAPTER_OPTIONS,
        initialValue: "cloudflare" as AdapterId,
      }),
    )) as AdapterId;
    return { ...base, output: "server", adapter };
  }

  const deploy = (await ask(() =>
    p.select({
      message: "Deploy target?",
      options: [
        { value: "cloudflare", label: "Cloudflare" },
        { value: "other", label: "Other" },
      ],
      initialValue: "cloudflare",
    }),
  )) as DeployTarget;
  return { ...base, output: "static", deploy };
}

/** Show one prompt; a cancelled prompt exits cleanly. */
async function ask<T>(prompt: () => Promise<T | symbol>): Promise<T> {
  const value = await prompt();
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
}
