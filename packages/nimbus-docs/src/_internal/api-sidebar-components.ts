import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ApiSpec } from "../types.js";
import { resolveApiFamily } from "./api/resolve-versions.js";
import { walkFilesSync } from "./fs-walk.js";
import { runningNimbusVersion } from "./upgrades.js";

/**
 * Identifies what a build's sidebar rows are made from, so the sidebar's
 * session cache drops rows cached from an older deployment. Rows come from
 * the API specs, the site's components, and Nimbus itself; an identical
 * input yields an identical id, so unchanged sites build byte-identical pages.
 */
export function navBuildId(
  api: readonly ApiSpec[],
  projectRoot: string,
  srcDir: string,
  base: string,
): string {
  const hash = createHash("sha256");
  const add = (value: string | Buffer) => hash.update(value).update("\0");
  add(runningNimbusVersion());
  add(base);
  add(JSON.stringify(api));
  for (const target of api.flatMap(resolveApiFamily)) {
    if (typeof target.spec !== "string") continue;
    try {
      add(fs.readFileSync(path.resolve(projectRoot, target.spec)));
    } catch {
      add(target.spec);
    }
  }
  const components = path.join(srcDir, "components");
  const files = [...walkFilesSync(components, { onReadError: "lenient" })].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
  );
  for (const file of files) {
    add(file.rel);
    add(fs.readFileSync(file.abs));
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * `sidebar: "on-demand"` relies on two starter components: `ApiSidebarItem`
 * renders collapsed groups as loadable, and `ApiLayout` mounts the loader.
 * With older copies, collapsed groups never open and page-less categories
 * link nowhere, so the integration fails the build with this message. Sites
 * that replaced these components (no file at the starter's path) are not
 * checked.
 */
export function outdatedApiSidebarError(
  api: readonly { collection: string; sidebar?: string }[],
  srcDir: string,
): string | undefined {
  const onDemand = api.filter((entry) => entry.sidebar === "on-demand");
  if (onDemand.length === 0) return undefined;
  const expected: Array<[file: string, marker: string]> = [
    ["components/ui/api-sidebar/ApiSidebarItem.astro", "childrenHref"],
    ["components/ui/api-layout/ApiLayout.astro", "initNavSidebar"],
  ];
  const outdated = expected.flatMap(([file, marker]) => {
    try {
      return fs.readFileSync(path.join(srcDir, file), "utf8").includes(marker) ? [] : [file];
    } catch {
      return [];
    }
  });
  if (outdated.length === 0) return undefined;
  const collections = onDemand.map((e) => `"${e.collection}"`).join(", ");
  return (
    `nimbus-docs: \`sidebar: "on-demand"\` (${collections}) needs newer API components. ` +
    `${outdated.map((f) => `src/${f}`).join(" and ")} ${outdated.length === 1 ? "predates" : "predate"} it, ` +
    `so collapsed groups would not open and x-tagGroups categories would link nowhere. ` +
    `Run \`npx @cloudflare/nimbus-docs add api-layout\` and choose Overwrite for api-layout and api-sidebar ` +
    `(Skip keeps your edits to the other components), or remove \`sidebar: "on-demand"\`.`
  );
}
