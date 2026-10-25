/**
 * `nimbus-docs add source <name|url>`: the registry's content sources. A name
 * is a listed source or one of its aliases (`github` is the `git` guide with a
 * `Host: GitHub` line); a URL is a provider's documentation, handed to the
 * generic guide as `Research start: <url>` and never put in a request.
 */

import type { RegistryIndexEntry } from "./_registry.generated.js";
import { listEntries } from "./resolver.js";

/** Kinds `add` reads as grammar. */
export const ADD_KINDS = ["source"] as const;

export interface ResolvedSource {
  entry: RegistryIndexEntry;
  /** The host an alias names (`GitHub` for `github`). */
  host?: string;
  /** The name as typed. */
  typed: string;
}

export function isSourceUrl(target: string): boolean {
  return target.includes("://");
}

/** A listed source by name or alias, or undefined. */
export function resolveSource(name: string): ResolvedSource | undefined {
  for (const entry of listEntries({ type: "registry:source" })) {
    if (entry.name === name) return { entry, typed: name };
    const host = entry.aliases?.[name];
    if (host) return { entry, host, typed: name };
  }
  return undefined;
}

/** Every name `add source` accepts, aliases included, for messages. */
export function sourceNames(): string[] {
  return listEntries({ type: "registry:source" }).flatMap((entry) => [entry.name, ...Object.keys(entry.aliases ?? {})]);
}

export function unknownSourceMessage(name: string): string {
  return (
    `Unknown source: \`${name}\`. Sources: ${sourceNames().join(", ")}, or an https:// URL of a provider's documentation. ` +
    "Any other git host: `add source git`."
  );
}

/** The guide with the lines the CLI prepends: an alias's host, or the URL to research. */
export function sourceGuide(markdown: string, prefix: string | undefined): string {
  // The registry's JSON frontmatter is metadata for `list`, not instructions:
  // the agent gets the guide from its first heading.
  const withoutMeta = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");
  const body = withoutMeta.endsWith("\n") ? withoutMeta : `${withoutMeta}\n`;
  return prefix ? `${prefix}\n\n${body}` : body;
}

/** The Sources group of `list`. */
export function formatSources(width: number): string[] {
  const lines = listEntries({ type: "registry:source" }).map((entry) => {
    const aliases = Object.keys(entry.aliases ?? {});
    const label = aliases.length ? `${entry.name} (${aliases.join(", ")})` : entry.name;
    return { label, description: entry.description };
  });
  lines.push({ label: "<url>", description: "Any other provider: a guide to write its loader, from its docs URL." });
  const pad = Math.max(width, ...lines.map((line) => line.label.length));
  return lines.map((line) => `    ${line.label.padEnd(pad + 2)}${line.description}`);
}
