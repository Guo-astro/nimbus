// A site scaffolded with an API reference compares against the starter tree
// composed the way the scaffolder composed it: generated files read as the
// starter's, the spec as the site's own, and upstream changes as updates.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveTemplateTree } from "../src/cli/_templates.js";
import { gatherOutdated } from "../src/cli/upgrade.js";
import { composeSiteFiles, type SiteRecord } from "../src/_internal/site-parts.js";

const ROUTE = "src/pages/[...slug].astro";

/** A template tree at one tag, its API route reading `route`. */
function tree(root: string, route: string): string {
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write("package.json", "{}\n");
  write("src/content.config.ts", "docs + partials\n");
  write(ROUTE, "docs route\n");
  write("src/content/docs/index.mdx", "home\n");
  write(".nimbus-parts/api/route.astro", route);
  write(".nimbus-parts/api/content.config.ts", "docs + partials + api\n");
  write(".nimbus-parts/api-only/content.config.ts", "partials + api\n");
  write(".nimbus-parts/api/openapi.yaml", "openapi: 3.1.0\n");
  write("AGENT.md", "docs guide\n");
  write(".nimbus-parts/api/AGENT.md", "spec at src/api/openapi.yaml\n");
  write(".nimbus-parts/api/astro.config.ts", 'api: [{ spec: "./src/api/openapi.yaml" }]\n');
  write(
    ".nimbus-parts/parts.json",
    JSON.stringify({
      schemaVersion: 1,
      api: {
        files: {
          "src/pages/api/[...slug].astro": "api/route.astro",
          "src/content.config.ts": "api/content.config.ts",
          "astro.config.ts": "api/astro.config.ts",
          "AGENT.md": "api/AGENT.md",
        },
        only: {
          files: { [ROUTE]: "api/route.astro", "src/content.config.ts": "api-only/content.config.ts" },
          remove: ["src/content/docs"],
        },
        spec: { from: "api/openapi.yaml", to: "src/api/openapi.yaml" },
        components: [],
        dependencies: {},
      },
    }),
  );
  return root;
}

test("an untouched API-only site reads as the starter, and an upstream route change as clean", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-site-parts-"));
  try {
    const trees: Record<string, string> = {
      "templates-v1.0.0": tree(path.join(root, "v1"), "api route\n"),
      "templates-v1.1.0": tree(path.join(root, "v1.1"), "api route, improved\n"),
    };
    const site: SiteRecord = { template: "api", api: { spec: "src/api/openapi.yaml" } };

    // The scaffold: the composed tree, the spec, the record.
    const project = path.join(root, "site");
    fs.cpSync(trees["templates-v1.0.0"]!, project, { recursive: true });
    composeSiteFiles(project, site);
    fs.rmSync(path.join(project, ".nimbus-parts"), { recursive: true });
    fs.mkdirSync(path.join(project, "src/api"));
    fs.writeFileSync(path.join(project, "src/api/openapi.yaml"), "openapi: 3.1.0\n# mine\n");
    fs.writeFileSync(
      path.join(project, "nimbus.json"),
      JSON.stringify({ templatesTag: "templates-v1.0.0", variant: "template", site, install: { root: "src" }, components: [] }),
    );

    const source = {
      resolve: (tag: string) => resolveTemplateTree({ variant: "template", tag, templateDir: trees[tag], site }),
      latestTag: async () => "templates-v1.1.0",
    };
    const outdated = await gatherOutdated(project, { json: true, all: true }, source);
    assert.deepEqual(
      outdated.starter.map(({ file, status }) => ({ file, status })),
      [{ file: ROUTE, status: "clean" }],
    );
    // Composing never touches the local trees it reads.
    assert.equal(fs.readFileSync(path.join(trees["templates-v1.0.0"]!, ROUTE), "utf8"), "docs route\n");
    assert.ok(fs.existsSync(path.join(trees["templates-v1.0.0"]!, "src/content/docs/index.mdx")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a site with a JSON spec reads as the starter: its guide and config name the spec it has", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-site-parts-"));
  try {
    const template = tree(path.join(root, "v1"), "api route\n");
    const site: SiteRecord = { template: "docs", api: { spec: "src/api/openapi.json" } };

    const project = path.join(root, "site");
    fs.cpSync(template, project, { recursive: true });
    composeSiteFiles(project, site);
    fs.rmSync(path.join(project, ".nimbus-parts"), { recursive: true });
    assert.equal(fs.readFileSync(path.join(project, "AGENT.md"), "utf8"), "spec at src/api/openapi.json\n");
    assert.equal(fs.readFileSync(path.join(project, "astro.config.ts"), "utf8"), 'api: [{ spec: "./src/api/openapi.json" }]\n');
    fs.writeFileSync(
      path.join(project, "nimbus.json"),
      JSON.stringify({ templatesTag: "templates-v1.0.0", variant: "template", site, install: { root: "src" }, components: [] }),
    );

    const source = {
      resolve: (tag: string) => resolveTemplateTree({ variant: "template", tag, templateDir: template, site }),
      latestTag: async () => "templates-v1.0.0",
    };
    const outdated = await gatherOutdated(project, { json: true, all: true }, source);
    assert.deepEqual(outdated.starter, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
