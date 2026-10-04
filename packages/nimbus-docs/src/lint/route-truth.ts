/**
 * Reads `.nimbus/routes.json`, the route list `astro build` writes for
 * `nimbus/internal-link`. Returns either the truth or a problem sentence
 * that names what's wrong and how to fix it. `nimbus-docs lint` turns a
 * problem into one `error` diagnostic (fail closed). The rule itself only
 * ever sees a usable file.
 */

import fs from "node:fs";
import path from "node:path";

import { ROUTE_TRUTH_VERSION, type RouteTruth } from "./site-model.js";

/** Project-relative path, as diagnostics print it. */
export const ROUTE_TRUTH_FILE = ".nimbus/routes.json";

export type RouteTruthResult =
  | { truth: RouteTruth; problem?: undefined }
  | { truth?: undefined; problem: string };

const REBUILD = "Run `astro build` to write it again.";

export function readRouteTruth(projectRoot: string): RouteTruthResult {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectRoot, ".nimbus", "routes.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        problem: `\`${ROUTE_TRUTH_FILE}\` is missing. Run \`astro build\` first; it writes the list of routes that links are checked against.`,
      };
    }
    return { problem: `\`${ROUTE_TRUTH_FILE}\` can't be read: ${(err as Error).message}. ${REBUILD}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { problem: `\`${ROUTE_TRUTH_FILE}\` isn't valid JSON: ${(err as Error).message}. ${REBUILD}` };
  }

  const record = (parsed ?? {}) as Partial<Record<keyof RouteTruth | "incomplete", unknown>>;
  if (record.incomplete === true) {
    return {
      problem: `\`${ROUTE_TRUTH_FILE}\` is from a build that didn't finish. Run \`astro build\` first; it writes the list of routes that links are checked against.`,
    };
  }
  if (record.version !== ROUTE_TRUTH_VERSION) {
    return {
      problem: `\`${ROUTE_TRUTH_FILE}\` has version ${JSON.stringify(record.version)}, but this version of Nimbus reads version ${ROUTE_TRUTH_VERSION}. ${REBUILD}`,
    };
  }
  if (
    !isStringArray(record.knownRoutes) ||
    !isStringArray(record.opaqueNamespaces) ||
    !isRedirectArray(record.redirects) ||
    !isRedirectArray(record.redirectPages) ||
    (record.redirectRules !== "cloudflare" && record.redirectRules !== "netlify")
  ) {
    return { problem: `\`${ROUTE_TRUTH_FILE}\` doesn't have the expected shape. ${REBUILD}` };
  }
  return {
    truth: {
      version: ROUTE_TRUTH_VERSION,
      base: typeof record.base === "string" ? record.base : "",
      knownRoutes: record.knownRoutes,
      redirects: record.redirects,
      redirectPages: record.redirectPages,
      redirectRules: record.redirectRules,
      opaqueNamespaces: record.opaqueNamespaces,
    },
  };
}

function isRedirectArray(value: unknown): value is RouteTruth["redirects"] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const r = item as Record<string, unknown> | null;
      return (
        r !== null &&
        typeof r === "object" &&
        typeof r.from === "string" &&
        typeof r.to === "string" &&
        typeof r.status === "number"
      );
    })
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
