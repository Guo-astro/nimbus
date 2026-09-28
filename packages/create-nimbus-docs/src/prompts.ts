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

  // Interactive mode
  const dir =
    opts.dir ??
    (await ask("Where should we create your project?", () =>
      p.text({
        message: "Where should we create your project?",
        placeholder: "./my-docs",
        validate: (value) => {
          if (!value) return "Directory is required";
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
    ((await ask("Starter content?", () =>
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
    ((await ask("Which package manager?", () =>
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
    opts.git === false
      ? false
      : await ask("Initialize a git repository?", () =>
          p.confirm({
            message: "Initialize a git repository?",
            initialValue: true,
          }),
        );

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

  const output = (await ask("Output mode?", () =>
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
    const adapter = (await ask("Which adapter?", () =>
      p.select({
        message: "Which adapter?",
        options: INTERACTIVE_ADAPTER_OPTIONS,
        initialValue: "cloudflare" as AdapterId,
      }),
    )) as AdapterId;
    return { ...base, output: "server", adapter };
  }

  const deploy = (await ask("Deploy target?", () =>
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

/**
 * Show one prompt. Without a terminal there is no one to answer it, so exit
 * with the flags that skip it instead of crashing inside the prompt library.
 * A cancelled prompt exits cleanly.
 */
async function ask<T>(question: string, prompt: () => Promise<T | symbol>): Promise<T> {
  if (!process.stdin.isTTY) {
    p.log.error(
      `No terminal to ask "${question}" Pass --yes to accept the defaults, and flags such as --content, --package-manager, --no-git, --deploy, or --adapter to choose others.`,
    );
    process.exit(1);
  }
  const value = await prompt();
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
}
