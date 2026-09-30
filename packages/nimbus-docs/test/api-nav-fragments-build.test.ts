// `sidebar: "on-demand"` end to end, through `astro build`: Nimbus injects the
// fragment route, renders it with the site's own `ApiSidebarItem`, and serves
// the same fragments prerendered and request-rendered. Pages carry the bounded
// nav in both modes, and every URL carries Astro's `base` once.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { build, type AstroIntegration } from "astro";

import nimbus from "../src/index.ts";
import { runningNimbusVersion } from "../src/_internal/upgrades.ts";
import { buildApiModel, getApiNav, type ApiNav } from "../src/api/index.js";
import { apiNavFragmentHref, apiNavGroups } from "../src/_internal/api/nav-bounds.js";
import { setLinkPolicy } from "../src/_internal/url.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const moduleUrl = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, relative)).href);
const SPEC = path.resolve(import.meta.dirname, "fixtures/api/smallco.yaml");
const BASE = "/docs";

// Request rendering is gated to the Cloudflare adapter; this stand-in takes its
// name and serves Astro's generated App directly.
function testAdapter(entrypoint: string): AstroIntegration {
  return {
    name: "@astrojs/cloudflare",
    hooks: {
      "astro:config:done": ({ setAdapter }) => {
        setAdapter({
          name: "@astrojs/cloudflare",
          entrypointResolution: "auto",
          serverEntrypoint: entrypoint,
          supportedAstroFeatures: { serverOutput: "stable" },
        });
      },
    },
  };
}

// A stand-in for the starter's row: enough structure to prove the fragment
// renders the site's component with the group's children.
const SIDEBAR_ITEM = `---
const { item } = Astro.props;
---
<div data-row={item.coordinate} data-src={item.childrenHref} data-deferred={item.deferred ? "" : undefined}>
  {item.label}
  {item.children.length > 0 && <ul>{item.children.map((child) => <li><Astro.self item={child} /></li>)}</ul>}
</div>`;

const PAGE = `---
import { getApiRoute, getApiStaticPaths } from ${moduleUrl("../src/runtime.ts")};
export const prerender = true;
export const getStaticPaths = getApiStaticPaths("api");
const result = await getApiRoute(Astro);
if (result instanceof Response) return result;
---
<main><nav-json set:html={JSON.stringify(result.nav).replaceAll("<", "\\\\u003c")}></nav-json></main>`;

interface Site {
  root: string;
  get(pathname: string): Promise<{ status: number; body: string }>;
}

async function buildSite(request: boolean): Promise<Site> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-nav-fragments-"));
  roots.push(root);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents, "utf8");
  };
  await symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const api = {
    collection: "api",
    sidebar: "on-demand" as const,
    versions: [
      { version: "v2", default: true, spec: SPEC },
      { version: "v1", spec: SPEC },
    ],
  };
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { apiCollection, docsCollection } from ${moduleUrl("../src/content.ts")};
export const collections = {
  docs: defineCollection(docsCollection()),
  api: defineCollection(apiCollection(${JSON.stringify(api)})),
};`,
  );
  await write("src/content/docs/guide.md", "---\ntitle: Guide\n---\n\nText.\n");
  await write("src/components/ui/api-sidebar/ApiSidebarItem.astro", SIDEBAR_ITEM);
  await write("src/pages/api/[...slug].astro", PAGE);
  // A rendering policy manages every collection's canonical route.
  await write(
    "src/pages/[...slug].astro",
    `---\nimport { getDocsStaticPaths } from ${moduleUrl("../src/runtime.ts")};\nexport const prerender = true;\nexport const getStaticPaths = getDocsStaticPaths;\n---\n<p>doc</p>`,
  );
  let adapter: AstroIntegration | undefined;
  if (request) {
    await write(
      "server-entry.mjs",
      `import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n`,
    );
    adapter = testAdapter(path.join(root, "server-entry.mjs"));
  }
  await build({
    root: pathToFileURL(`${root}${path.sep}`),
    cacheDir: path.join(root, ".astro"),
    outDir: "./dist",
    build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
    vite: { cacheDir: path.join(root, ".vite") },
    base: BASE,
    ...(adapter ? { output: "server" as const, adapter } : {}),
    logLevel: "silent",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Test",
          description: "Test",
          search: false,
          api: [api],
          ...(request ? { rendering: { default: "build", collections: { api: "request" } } } : {}),
        },
        { admonitions: false, sitemap: false, validateMdx: false },
      ),
    ],
  });

  if (!request) {
    return {
      root,
      async get(pathname) {
        const file = path.join(root, "dist", pathname.slice(BASE.length), "index.html");
        try {
          return { status: 200, body: await readFile(file, "utf8") };
        } catch {
          return { status: 404, body: "" };
        }
      },
    };
  }
  const { app } = (await import(pathToFileURL(path.join(root, ".server/entry.mjs")).href)) as {
    app: { render(request: Request): Promise<Response> };
  };
  return {
    root,
    async get(pathname) {
      const response = await app.render(new Request(`https://example.test${pathname}`));
      return { status: response.status, body: await response.text() };
    },
  };
}

function navOf(html: string): ApiNav {
  const json = /<nav-json>([\s\S]*)<\/nav-json>/.exec(html)?.[1];
  assert.ok(json, "page renders its nav");
  return JSON.parse(json) as ApiNav;
}

let expected: { version: string | null; mountPath: string; full: ApiNav }[];
before(async () => {
  setLinkPolicy({ trailingSlash: "ignore", format: "directory" });
  expected = [];
  for (const [version, mountPath] of [[null, "/api"], ["v1", "/api/v1"]] as const) {
    const model = await buildApiModel({ collection: "api", spec: await readFile(SPEC, "utf8"), mountPath });
    expected.push({ version, mountPath, full: getApiNav(model) });
  }
});

for (const request of [false, true]) {
  describe(`on-demand fragments, ${request ? "request-rendered" : "prerendered"}`, () => {
    let site: Site;
    before(async () => {
      site = await buildSite(request);
    });

    test("every group of every version has a fragment rendered by the site's row", async () => {
      for (const { mountPath, full } of expected) {
        const groups = apiNavGroups(full);
        assert.ok(groups.length > 0);
        for (const group of groups) {
          const { status, body } = await site.get(`${BASE}${apiNavFragmentHref(mountPath, group.coordinate)}`);
          assert.equal(status, 200, group.coordinate);
          assert.match(body, new RegExp(`data-row="${group.coordinate.replace(/[.]/g, "\\.")}"`));
          for (const child of group.children) assert.ok(body.includes(`data-row="${child.coordinate}"`));
          assert.doesNotMatch(body, /<html|<head|<body/, "a fragment is a partial");
        }
      }
    });

    test("pages carry the bounded nav, pointing at fragments", async () => {
      const { status, body } = await site.get(`${BASE}/api/`);
      assert.equal(status, 200);
      const nav = navOf(body);
      for (const item of nav.items) {
        assert.equal(item.deferred, true, item.coordinate);
        assert.equal(item.childrenHref, apiNavFragmentHref("/api", item.coordinate));
      }
    });

    test("an unknown fragment is not found", async () => {
      assert.equal((await site.get(`${BASE}/nimbus-api/nav/api/nope-00000000/`)).status, 404);
      assert.equal((await site.get(`${BASE}/nimbus-api/nav/api/v9/nope-00000000/`)).status, 404);
    });

    if (!request) {
      test("static output writes exactly one fragment per group", async () => {
        const count = async (dir: string): Promise<number> =>
          (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== "v1").length;
        const navRoot = path.join(site.root, "dist/nimbus-api/nav/api");
        assert.equal(await count(navRoot), apiNavGroups(expected[0]!.full).length);
        assert.equal(await count(path.join(navRoot, "v1")), apiNavGroups(expected[1]!.full).length);
      });
    }
  });
}

test("on-demand without the site's row component fails with the expected path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-nav-fragments-missing-"));
  roots.push(root);
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
  await writeFile(path.join(root, "nimbus.json"), `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await assert.rejects(
    build({
      root: pathToFileURL(`${root}${path.sep}`),
      cacheDir: path.join(root, ".astro"),
      vite: { cacheDir: path.join(root, ".vite") },
      logLevel: "silent",
      integrations: [
        nimbus(
          {
            site: "https://example.test",
            title: "Test",
            description: "Test",
            search: false,
            api: [{ collection: "api", spec: SPEC, sidebar: "on-demand" }],
          },
          { admonitions: false, sitemap: false, validateMdx: false },
        ),
      ],
    }),
    /src\/components\/ui\/api-sidebar\/ApiSidebarItem\.astro/,
  );
});
