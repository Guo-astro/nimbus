import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build as buildAstro } from "astro";
import { build } from "vite";
import { virtualAgentCapabilitiesPlugin } from "../src/_internal/virtual-agent-capabilities.js";
import { iconVirtualPlugin } from "../src/_internal/icon-virtual.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

test("the Connect MCP client is bundled only when the endpoint is enabled", async () => {
  const component = path.resolve(
    import.meta.dirname,
    "../../nimbus-starter-source/src/components/ConnectMcp.astro",
  );
  const source = await readFile(component, "utf8");
  const script = source.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const root = await mkdtemp(path.join(TEST_TMP, "mcp-client-"));
  try {
    const entry = component.replaceAll("\\", "/") + "?astro&type=script";
    for (const enabled of [false, true]) {
      const result = await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          {
            name: "astro-script-fixture",
            resolveId: (id) => (id === entry ? entry : undefined),
            load: (id) => (id === entry ? script : undefined),
          },
          virtualAgentCapabilitiesPlugin(async () => ({
            capabilities: {
              search: "unavailable",
              versions: [],
              apis: [],
              ...(enabled ? { mcpUrl: "https://docs.example.com/mcp" } : {}),
            },
            options: {
              site: "https://docs.example.com",
              title: "Docs",
              base: "/",
            },
          })),
        ],
        build: { write: false, rollupOptions: { input: entry }, minify: true },
      });
      assert.ok(!Array.isArray(result) && "output" in result);
      const chunks = result.output.filter((item) => item.type === "chunk");
      assert.equal(
        chunks.some((chunk) => chunk.code.includes("data-nb-connect-mcp")),
        enabled,
      );
      if (!enabled)
        assert.ok(
          chunks.every((chunk) => chunk.code.trim() === ""),
          chunks.map((chunk) => chunk.code).join("\n"),
        );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Astro page emits no Connect MCP script when the endpoint is disabled", async () => {
  const starter = path.resolve(
    import.meta.dirname,
    "../../nimbus-starter-source/src",
  );
  const root = await mkdtemp(path.join(TEST_TMP, "mcp-component-"));
  try {
    await symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(path.join(root, "src/pages"), { recursive: true });
    await writeFile(
      path.join(root, "src/pages/index.astro"),
      `---
import ConnectMcp from ${JSON.stringify(pathToFileURL(path.join(starter, "components/ConnectMcp.astro")).href)};
---
<html><body><ConnectMcp /></body></html>`,
    );
    await buildAstro({
      root: pathToFileURL(`${root}${path.sep}`),
      configFile: false,
      logLevel: "silent",
      vite: {
        resolve: {
          alias: {
            "@": starter,
            "@cloudflare/nimbus-docs/client": path.resolve(
              import.meta.dirname,
              "../src/client/index.ts",
            ),
          },
        },
        plugins: [
          iconVirtualPlugin({ root, include: {} }),
          virtualAgentCapabilitiesPlugin(async () => ({
            capabilities: { search: "unavailable", versions: [], apis: [] },
            options: {
              site: "https://docs.example.com",
              title: "Docs",
              base: "/",
            },
          })),
        ],
      },
    });
    const html = await readFile(path.join(root, "dist/index.html"), "utf8");
    assert.doesNotMatch(html, /data-nb-connect-mcp/);
    const scripts = await readdir(path.join(root, "dist"), { recursive: true });
    assert.ok(
      !scripts.some((file) => path.basename(file).startsWith("ConnectMcp.")),
      scripts.join("\n"),
    );
    for (const file of scripts.filter((file) => file.endsWith(".js"))) {
      assert.doesNotMatch(
        await readFile(path.join(root, "dist", file), "utf8"),
        /data-nb-connect-mcp/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
