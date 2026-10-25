/**
 * Feature installer — agent-handoff.
 *
 * If `--print` is set OR `determineAgent()` says the CLI is running inside
 * a known coding agent, the markdown is piped to stdout for the agent to
 * consume. Otherwise we print human-friendly instructions on stderr
 * telling the user exactly how to pipe the output to their agent of choice.
 *
 * No picker, no clipboard mode — the printed pipe commands cover both.
 */

import { determineAgent } from "@vercel/detect-agent";

import { invocation } from "./pm.js";
import { fetchFeatureMarkdown } from "./resolver.js";

export interface FeatureInstallOptions {
  /** Force markdown to stdout regardless of agent detection. */
  print: boolean;
}

export async function shouldUseAgentHandoff(force: boolean): Promise<boolean> {
  if (force) return true;
  const detected = await determineAgent().catch(() => ({
    isAgent: false as const,
  }));
  return detected.isAgent === true;
}

export async function installFeature(
  slug: string,
  options: FeatureInstallOptions,
): Promise<void> {
  const markdown = await fetchFeatureMarkdown(slug);

  // Predicate: explicit --print, or detection says we're running inside
  // a known agent (which captures our stdout).
  const isAgentMode = await shouldUseAgentHandoff(options.print);

  if (isAgentMode) {
    process.stdout.write(markdown);
    if (!markdown.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  printHumanInstructions(slug);
}

/**
 * Stderr-only. We don't put this on stdout because if the user pipes our
 * output anywhere by accident, only the markdown should reach the agent.
 *
 * Agents are listed with a blank line between the "first-tier" CLIs
 * (claude/codex/cursor-agent) and the rest (opencode/pi).
 */
function printHumanInstructions(slug: string): void {
  process.stderr.write(humanInstructions(invocation(`add ${slug}`)));
}

export function humanInstructions(cmd: string): string {
  return [
    `${cmd}\n\n`,
    "To install this feature, pipe it to your coding agent:\n\n",
    `  ${cmd} --print | claude\n`,
    `  ${cmd} --print | codex\n`,
    `  ${cmd} --print | cursor-agent\n\n`,
    `  ${cmd} --print | opencode\n`,
    `  ${cmd} --print | pi\n\n`,
    "Or paste this prompt into any agent:\n\n",
    `  Run "${cmd} --print" and follow the instructions.\n`,
  ].join("");
}
