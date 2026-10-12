import type { VitePluginLike } from "./virtual-config.js";

const RESOLVED_ID = "\0virtual:nimbus/last-updated";

export function virtualLastUpdatedPlugin(
  dates: Record<string, string> | null,
): VitePluginLike {
  return {
    name: "nimbus-docs:virtual-last-updated",
    enforce: "pre",
    resolveId(id: string, importer?: string) {
      const normalizedId = id.replace(/\\/g, "/").replace(/\?.*$/, "");
      const normalizedImporter = importer
        ?.replace(/\\/g, "/")
        .replace(/\?.*$/, "");
      if (
        dates &&
        (normalizedId.endsWith("/_internal/git-last-updated.js") ||
          /(?:^|\/)git-last-updated-[\w-]+\.js$/.test(normalizedId)) &&
        /\/runtime\.[jt]s$/.test(normalizedImporter ?? "")
      ) {
        return RESOLVED_ID;
      }
      return undefined;
    },
    load(id: string) {
      if (id !== RESOLVED_ID || !dates) return undefined;
      return (
        `const dates = ${JSON.stringify(dates)};\n` +
        "export async function getLastUpdatedFromGit(path) {\n" +
        '  const value = dates[path.replace(/\\\\/g, "/")];\n' +
        "  return value ? new Date(value) : undefined;\n" +
        "}\n"
      );
    },
  };
}
