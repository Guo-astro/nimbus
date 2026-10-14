import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeWorkerName, workersCompatibilityDate } from "@cloudflare/nimbus-docs/adapters";

/**
 * Apply deploy target configuration.
 *
 * - "cloudflare": Emit a `wrangler.jsonc` pointing Workers Static Assets at
 *                 `./dist`. No Astro adapter — a Nimbus docs site is a pure
 *                 static build and Cloudflare deploys static dirs directly.
 *                 Adding `@astrojs/cloudflare` here pulls satteri's WASI
 *                 entry into vite's bundling and breaks the build, and pays
 *                 nothing for the trouble (no SSR, no edge functions).
 *                 AI markdown stays static and repo-owned by default, same as
 *                 the "other" target. Cloudflare-specific runtime conversion
 *                 and content negotiation belong in recipes, not the default
 *                 free-tier scaffold.
 * - "other":      No wrangler, vanilla static Astro output.
 *
 * The `// nimbus:adapter` marker is left in place: it is the anchor
 * `nimbus-docs add adapter-*` edits to flip `output` and wire an adapter.
 */
export async function applyDeployTarget(
  dir: string,
  target: "cloudflare" | "other",
): Promise<void> {
  if (target === "cloudflare") {
    await writeWranglerConfig(dir);
    // wrangler (added by updatePackageJson) pulls workerd, which trips pnpm's
    // build-scripts gate. Decline it here — where its dependency is added.
    declineBuildScript(dir, "workerd");
  }
}

/**
 * Add `<name>` to both decline lists in the generated pnpm-workspace.yaml
 * (pnpm-11 `allowBuilds` map + pnpm-10 `ignoredBuiltDependencies` list).
 * No-op if already listed or the file is absent.
 */
export function declineBuildScript(dir: string, name: string): void {
  const wsPath = join(dir, "pnpm-workspace.yaml");
  if (!existsSync(wsPath)) return;
  let text = readFileSync(wsPath, "utf-8");
  if (!new RegExp(`^[ \\t]+${name}:\\s`, "m").test(text)) {
    text = text.replace(
      /^(allowBuilds:.*\n(?:[ \t]+\S.*\n)*)/m,
      (block) => `${block}  ${name}: false\n`,
    );
  }
  if (!new RegExp(`^[ \\t]+-\\s+${name}\\s*$`, "m").test(text)) {
    text = text.replace(
      /^(ignoredBuiltDependencies:.*\n(?:[ \t]+-.*\n)*)/m,
      (block) => `${block}  - ${name}\n`,
    );
  }
  writeFileSync(wsPath, text);
}

async function writeWranglerConfig(dir: string): Promise<void> {
  const projectName = dir.split(/[\\/]/).pop() ?? "my-docs";
  const compatibilityDate = await workersCompatibilityDate(dir);
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify(
      {
        $schema: "node_modules/wrangler/config-schema.json",
        name: sanitizeWorkerName(projectName),
        compatibility_date: compatibilityDate,
        assets: {
          directory: "./dist",
          not_found_handling: "404-page",
        },
      },
      null,
      2,
    ) + "\n",
  );
}
