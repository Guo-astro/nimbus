/**
 * A site's parts beyond the docs starter: the API reference, beside the docs
 * (`--api`) or as the whole site (`--template api`). Each template variant
 * carries its parts in `.nimbus-parts/`: the files they add or replace, what
 * they remove, and the API's registry components. The rules travel with the
 * template tag, so a starter tree rebuilt at an old tag composes the way that
 * release scaffolded it, whatever CLI reads it.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SITE_PARTS_DIR = ".nimbus-parts";
const SCHEMA_VERSION = 1;

/** What `create-nimbus-docs` built, as `nimbus.json` records it. Absent means docs only. */
export interface SiteRecord {
  template: "docs" | "api";
  /** The spec the scaffold wrote, project-relative POSIX; `false` without the API. */
  api: { spec: string } | false;
}

/** Files a part writes, by project path, from a path inside `.nimbus-parts/`. */
type PartFiles = Record<string, string>;

export interface SitePartsComponent {
  slug: string;
  type: string;
  version: string;
  hash: string;
  /** Paths under the project's install root (`components/ui/api-layout/…`), stored under `components/` in the payload. */
  files: string[];
}

export interface SitePartsManifest {
  schemaVersion: number;
  api: {
    /** The API beside the docs: starter files added or replaced. */
    files: PartFiles;
    /** The API as the whole site: replaces `files`. */
    only: { files: PartFiles; remove: string[] };
    /** The sample spec: copied once, then the site's own, never compared. */
    spec: { from: string; to: string };
    components: SitePartsComponent[];
    dependencies: Record<string, string>;
  };
}

/** The parts a template tree carries, or null for a tree from before parts. */
export function readSiteParts(treeDir: string): SitePartsManifest | null {
  const file = join(treeDir, SITE_PARTS_DIR, "parts.json");
  if (!existsSync(file)) return null;
  const manifest = JSON.parse(readFileSync(file, "utf8")) as SitePartsManifest;
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${SITE_PARTS_DIR}/parts.json has schema ${manifest.schemaVersion}; this version of Nimbus reads ${SCHEMA_VERSION}. Update @cloudflare/nimbus-docs.`,
    );
  }
  return manifest;
}

/**
 * Write a site's starter files into `dir`, a template tree: the API's route
 * and content config, and for an API-only site the removed docs. Leaves out
 * what the site owns from the start (the spec) and what the registry records
 * (the components), so a tree composed for comparison holds starter files only.
 */
export function composeSiteFiles(dir: string, site: SiteRecord | undefined): void {
  if (!site?.api) return;
  const manifest = readSiteParts(dir);
  if (!manifest) {
    throw new Error(`This template has no ${SITE_PARTS_DIR}/, so it can't make a site with an API reference.`);
  }
  const part = site.template === "api" ? manifest.api.only : { files: manifest.api.files, remove: [] };
  for (const path of part.remove) {
    rmSync(join(dir, path), { recursive: true, force: true });
    // A folder the removal empties (src/content/) goes too.
    const parent = join(dir, dirname(path));
    if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true });
  }
  for (const [to, from] of Object.entries(part.files)) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    cpSync(join(dir, SITE_PARTS_DIR, from), join(dir, to));
  }
  // A spec of the site's own type (openapi.json) is named where the sample's is.
  const sample = manifest.api.spec.to;
  if (site.api.spec !== sample) {
    const configPath = join(dir, "astro.config.ts");
    const config = readFileSync(configPath, "utf8");
    const entry = `spec: "./${sample}"`;
    if (!config.includes(entry)) throw new Error(`The template's astro.config.ts has no ${entry} to point at the site's spec.`);
    writeFileSync(configPath, config.replace(entry, `spec: "./${site.api.spec}"`));
    const guidePath = join(dir, "AGENT.md");
    // By file name: the guide's file tree names the spec without `src/`.
    if (existsSync(guidePath)) {
      writeFileSync(guidePath, readFileSync(guidePath, "utf8").replaceAll(basename(sample), basename(site.api.spec)));
    }
  }
}
