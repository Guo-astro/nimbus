import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER_RECIPES, type AdapterId } from "@cloudflare/nimbus-docs/adapters";

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

type UpdateOptions = { name: string } & (
  | { output: "static"; deploy: "cloudflare" | "other" }
  | { output: "server"; adapter: AdapterId }
);

export async function updatePackageJson(
  targetDir: string,
  options: UpdateOptions,
): Promise<void> {
  const pkgPath = join(targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;

  pkg.name = sanitizePackageName(options.name);
  pkg.version = "0.0.1";
  // A scaffolded docs site is an application, not a publishable package.
  // Keep `private: true` so an accidental `npm publish` is refused.
  pkg.private = true;

  if (options.output === "static") {
    if (options.deploy === "cloudflare") {
      // Wrangler ships Workers Static Assets — no Astro adapter needed. A
      // docs site is a pure static build; the adapter would only be paid-for
      // weight (and currently breaks vite resolution for satteri's WASI
      // entry under the cloudflare adapter context).
      // Same major as the Cloudflare recipe's `wranglerFloor`: a new config's
      // compatibility date is read from that major's workerd.
      addWrangler(pkg, "^4.95.0");
      addCloudflareScripts(pkg);
    }
  } else {
    const recipe = ADAPTER_RECIPES[options.adapter];
    pkg.dependencies ??= {};
    // Server output needs the adapter at runtime — `dependencies`, not `dev`.
    for (const spec of [recipe.installSpec, ...recipe.extraDeps]) {
      const { name, range } = splitSpec(spec);
      pkg.dependencies[name] = range;
    }

    if (options.adapter === "node") {
      pkg.scripts ??= {};
      pkg.scripts.start = "node ./dist/server/entry.mjs";
    }

    // Cloudflare is the one adapter that ships a user `wrangler.jsonc`; the
    // rest let their platform own the deploy. Pin wrangler to the server
    // build's floor up front (the CLI opt-in can only warn on a pre-existing
    // static pin), and reuse the Cloudflare build/preview/deploy scripts.
    if (options.adapter === "cloudflare") {
      addWrangler(pkg, splitSpec(recipe.serverWrangler!.wranglerFloor).range);
      addCloudflareScripts(pkg);
    }
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function addWrangler(pkg: PackageJson, range: string): void {
  pkg.devDependencies ??= {};
  pkg.devDependencies.wrangler = range;
}

function addCloudflareScripts(pkg: PackageJson): void {
  pkg.scripts ??= {};
  // Keep preview/deploy self-contained: Cloudflare projects always build first.
  // No linter chain — a fresh docs starter is mostly MDX, and `astro check`
  // already covers type safety. If users want biome/eslint later, they wire it in.
  pkg.scripts["prepreview:cf"] = "astro build";
  pkg.scripts["preview:cf"] = "wrangler dev";
  pkg.scripts.predeploy = "astro check && astro build";
  pkg.scripts.deploy = "wrangler deploy";
}

// `@scope/pkg@range` → { name: "@scope/pkg", range } (a leading `@` scope isn't
// a version separator). Mirrors the CLI installer's `depName` split.
function splitSpec(spec: string): { name: string; range: string } {
  const at = spec.lastIndexOf("@");
  if (at > 0) return { name: spec.slice(0, at), range: spec.slice(at + 1) };
  return { name: spec, range: "*" };
}

function sanitizePackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[._]/, "")
    .slice(0, 214);
}
