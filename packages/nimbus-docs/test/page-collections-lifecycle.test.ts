import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import nimbus from "../src/index.js";
import { pageCollectionsFilePath } from "../src/_internal/page-collections.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";

// `astro dev` runs config setup with `command: "dev"`, `astro check` with
// `"sync"`. Only a build rewrites the page-collection list, so only a build
// may clear it.
for (const [command, kept] of [
  ["dev", true],
  ["sync", true],
  ["build", false],
] as const) {
  test(`config setup for "${command}" ${kept ? "keeps" : "clears"} the build's page-collection list`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "nimbus-page-collections-life-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const write = async (relative: string, body: string) => {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body, "utf8");
    };
    await write(
      "nimbus.json",
      JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }),
    );
    await write("src/content.config.ts", "export const collections = { docs: {} };\n");
    await write("src/components.ts", "export const components = {};\n");
    await write("src/pages/[...slug].astro", "---\n---\n");
    const list = pageCollectionsFilePath(root);
    await write(
      path.relative(root, list),
      JSON.stringify({ version: 1, collections: ["docs"], mdxFiles: [] }),
    );

    const integration = nimbus(
      { site: "https://example.test", title: "Docs", search: false },
      { validateMdx: false, admonitions: false, sitemap: false, markdown: { processor: {} as never } },
    );
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fork() {
        return this;
      },
    };
    await integration.hooks["astro:config:setup"]!({
      updateConfig: () => ({}) as never,
      injectRoute: () => {},
      addWatchFile: () => {},
      config: {
        root: pathToFileURL(`${root}${path.sep}`),
        srcDir: pathToFileURL(`${path.join(root, "src")}${path.sep}`),
        cacheDir: pathToFileURL(`${path.join(root, ".cache")}${path.sep}`),
        base: "",
        trailingSlash: "ignore",
        build: { format: "directory" },
      },
      logger,
      command,
    } as never);

    assert.equal(existsSync(list), kept);
  });
}
