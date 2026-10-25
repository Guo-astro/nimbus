#!/usr/bin/env node
/**
 * PR CI for the scaffolder's site parts: scaffolds a docs site with an API
 * reference (`--api`), an API-only site (`--template api`), static and on a
 * server adapter, through the real scaffolder from freshly generated templates.
 * Each builds against the packed workspace `nimbus-docs`, passes `check`, serves
 * the reference where its route says, and reads as an untouched starter to
 * `outdated`. `templates-check.mjs` covers the docs-only site.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateTemplates } from "../packages/create-nimbus-docs/scripts/copy-template.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAFFOLDER = resolve(ROOT, "packages/create-nimbus-docs/dist/index.js");
const NIMBUS_NAME = "@cloudflare/nimbus-docs";

const cleanup = [];
process.on("exit", () => {
  if (!process.env.NIMBUS_KEEP_SITE_PARTS) for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function run(bin, args, opts = {}) {
  const result = spawnSync(bin, args, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", ...opts });
  if (result.status !== 0 && !opts.allowFailure) {
    console.error(result.stdout ?? "", result.stderr ?? "");
    console.error(`[site-parts-check] FAILED: ${bin} ${args.join(" ")}`);
    process.exit(1);
  }
  return result;
}
const ok = (message) => console.log(`[site-parts-check] ok — ${message}`);

run("pnpm", ["--filter", "./packages/nimbus-docs", "--filter", "./packages/create-nimbus-docs", "build"]);
const work = mkdtempSync(join(tmpdir(), "nimbus-site-parts-"));
cleanup.push(work);
const templates = join(work, "templates");
generateTemplates(templates);
run("pnpm", ["--filter", "./packages/nimbus-docs", "exec", "pnpm", "pack", "--pack-destination", work]);
const tarball = join(work, readdirSync(work).find((file) => file.endsWith(".tgz")));

const SITES = [
  { name: "docs-api", flags: ["--api"], mount: "/api", docs: true },
  { name: "api-only", flags: ["--template", "api"], mount: "", docs: false },
  { name: "api-only-node", flags: ["--template", "api", "--adapter", "node"], mount: "", docs: false, server: true },
];

for (const { name, flags, mount, docs, server } of SITES) {
  run("node", [SCAFFOLDER, name, "--yes", "--skip-install", "--no-git", "--package-manager", "pnpm", "--template-dir", templates, ...flags], { cwd: work });
  const site = join(work, name);
  const read = (file) => readFileSync(join(site, file), "utf8");

  assert.ok(!existsSync(join(site, ".nimbus-parts")), `${name}: the parts payload stays out of the site`);
  const nimbus = JSON.parse(read("nimbus.json"));
  assert.deepEqual(nimbus.site, { template: docs ? "docs" : "api", api: { spec: "src/api/openapi.yaml" } });
  assert.deepEqual(nimbus.components.map((c) => c.slug).sort(), ["api-code-rail", "api-field-row", "api-layout", "api-sidebar", "popover", "version-switcher"]);
  const route = mount ? "src/pages/api/[...slug].astro" : "src/pages/[...slug].astro";
  assert.match(read(route), /getApiRoute\(Astro, "api"/);
  assert.equal(existsSync(join(site, "src/content/docs")), docs);
  assert.equal(existsSync(join(site, "src/pages/api")), docs, `${name}: one API route`);
  assert.match(read("src/content.config.ts"), /api: defineCollection\(apiCollection\(\)\)/);
  assert.equal(/docs: defineCollection/.test(read("src/content.config.ts")), docs);
  const config = read("astro.config.ts");
  assert.match(config, /convention: "resource-action-v2"/);
  assert.equal(/autogenerate: \{ collection: "docs" \}/.test(config), docs);
  if (server) assert.doesNotMatch(config, /"docs": "request"/, `${name}: no request rendering for a docs collection it lacks`);

  const pkgPath = join(site, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.ok(pkg.dependencies["@scalar/openapi-parser"], `${name}: the API engine's peers are installed`);
  pkg.dependencies[NIMBUS_NAME] = `file:${tarball}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: site });
  run("pnpm", ["typecheck"], { cwd: site });
  const build = run("pnpm", ["build"], { cwd: site, capture: true });
  const log = `${build.stdout}\n${build.stderr}`;
  assert.match(log, /Indexed \d+ API pages for "api"/, `${name}: the build indexes the API`);
  assert.doesNotMatch(log, /collection "docs" does not exist/, `${name}: no docs warning`);

  const dist = join(site, server ? "dist/client" : "dist");
  for (const file of ["index.html", "index.md", "llms.txt", "sitemap-0.xml"]) {
    assert.ok(existsSync(join(dist, file)), `${name}: ${file}`);
  }
  for (const file of ["index.html", "index.md", "locations/list/index.html", "locations/list/index.md", "openapi.json"]) {
    assert.ok(existsSync(join(dist, mount, file)), `${name}: ${mount}/${file}`);
  }
  if (!docs) assert.ok(!existsSync(join(dist, "api")), `${name}: nothing under /api`);
  const home = readFileSync(join(dist, "index.html"), "utf8");
  if (docs) {
    assert.match(home, /aria-label="Sections"[\s\S]*?href="\/api\/"[^>]*>\s*API reference/, `${name}: an API reference tab`);
  } else {
    assert.doesNotMatch(home, /aria-label="Sections"/, `${name}: no tabs on a site that is only the reference`);
  }

  const check = run("pnpm", ["exec", "nimbus-docs", "check"], { cwd: site, capture: true, allowFailure: true });
  // \`check\` lists the URLs a route moves; /api is the API's default.
  if (!mount) assert.match(check.stdout, /api\s+\/\s/, `${name}: check lists the API at /\n${check.stdout}`);
  assert.doesNotMatch(check.stdout, /✗/, `${name}: check passes\n${check.stdout}`);

  const outdated = run("pnpm", ["exec", "nimbus-docs", "outdated", "--json", "--all", "--template-dir", templates], { cwd: site, capture: true, allowFailure: true });
  const report = JSON.parse(outdated.stdout);
  const starter = report.starter?.findings ?? report.starter ?? [];
  assert.deepEqual(starter, [], `${name}: an untouched scaffold reads as the starter\n${outdated.stdout}`);
  for (const item of report.registry) assert.notEqual(item.local, "edited", `${name}: ${item.slug} reads as installed, unedited`);
  ok(`${name}: scaffolds, builds, checks and reads as an untouched starter`);
}
