// `agents: { discovery: false }` leaves origin-root discovery to the site
// that owns the domain: no Nimbus files, links or header rules for it, and the
// site's own files kept, in builds, root copies and `astro dev`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { build, dev, type AstroIntegration } from "astro";
import { discoveryFixture } from "./fixtures/agent-discovery-site.js";
import { createAgentCapabilities } from "../src/_internal/agent-capabilities.js";
import { agentDiscoveryHeaderRules, agentHomepageLinks } from "../src/_internal/agent-discovery.js";

const OFF = { agents: { discovery: false } };
const OWN_ARD = '{"entries":[{"url":"https://example.test/owned"}]}\n';
const DISCOVERY_RULES = /\/\.well-known\/(ard\.json|ai-catalog\.json|api-catalog)\n/;

/** The site's @astrojs/cloudflare-named stand-in: Astro's App behind a plain entrypoint. */
function cloudflareNamed(entrypoint: string): AstroIntegration {
  return {
    name: "@astrojs/cloudflare",
    hooks: {
      "astro:config:done": ({ setAdapter }) =>
        setAdapter({
          name: "@astrojs/cloudflare",
          entrypointResolution: "auto",
          serverEntrypoint: entrypoint,
          supportedAstroFeatures: { serverOutput: "stable" },
        }),
    },
  };
}

async function captured<T>(run: () => Promise<T>): Promise<string> {
  const output: string[] = [];
  const restore = [process.stdout, process.stderr].map((stream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array) => (output.push(String(chunk)), true)) as typeof stream.write;
    return () => (stream.write = original);
  });
  try {
    await run();
  } finally {
    for (const reset of restore) reset();
  }
  return output.join("");
}

test("off under a base: no discovery files or links, the site's own file and other links kept", async () => {
  const site = await discoveryFixture(undefined, "docs", true, undefined, OFF);
  try {
    await site.write("public/.well-known/ard.json", OWN_ARD);
    // An earlier build's generated block beside an owner rule.
    await site.write(
      "public/_headers",
      [
        "/custom",
        "  X-Owner: unchanged",
        "",
        "# Nimbus agent discovery (generated)",
        "/.well-known/ard.json",
        "  Content-Type: application/json",
        "  Access-Control-Allow-Origin: *",
        "# End Nimbus agent discovery",
        "",
      ].join("\n"),
    );
    const log = await captured(() => build({ ...site.config, logLevel: "info" }));
    assert.equal(await site.read("dist/.well-known/ard.json"), OWN_ARD);
    assert.equal(existsSync(path.join(site.root, "dist/.well-known/ai-catalog.json")), false);
    assert.equal(existsSync(path.join(site.root, "dist/.well-known/api-catalog")), false);
    const headers = await site.read("dist/_headers");
    assert.match(headers, /^\/custom\n {2}X-Owner: unchanged$/m);
    assert.doesNotMatch(headers, /rel="ard"|rel="api-catalog"/);
    assert.doesNotMatch(headers, DISCOVERY_RULES);
    for (const rel of ["describedby", "alternate", "service-doc", "service-desc"])
      assert.match(headers, new RegExp(`rel="${rel}"`), rel);
    // The API spec still publishes, with its media-type rule.
    assert.ok(existsSync(path.join(site.root, "dist/pets/openapi.json")));
    assert.match(headers, /^\/docs\/pets\/openapi\.json\n {2}Content-Type: application\/vnd\.oai\.openapi\+json/m);
    assert.doesNotMatch(log, /Agent discovery files are under/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("on under a base without a root copy: the build says where the files are and both fixes", async () => {
  const site = await discoveryFixture();
  try {
    const log = await captured(() => build({ ...site.config, logLevel: "info" }));
    assert.match(
      log,
      /Agent discovery files are under \/docs\/\.well-known\/, but agents only read \/\.well-known\/ at the origin root\. Serve this directory there, or set agents: \{ discovery: false \} if another site owns it\./,
    );
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("the Cloudflare adapter's root copies follow the switch", async () => {
  for (const off of [false, true]) {
    const site = await discoveryFixture(undefined, "docs", true, undefined, off ? OFF : {});
    try {
      await site.write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
      const client = path.join(site.root, "out/docs");
      await build({
        ...site.config,
        output: "server",
        adapter: cloudflareNamed(path.join(site.root, "server-entry.mjs")),
        build: { client, server: path.join(site.root, ".server") },
      } as never);
      for (const file of ["ard.json", "ai-catalog.json", "api-catalog"])
        assert.equal(existsSync(path.join(site.root, "out/.well-known", file)), !off, `${file} off=${off}`);
      const headers = await site.read("out/_headers");
      assert.equal(/rel="ard"/.test(headers), !off, headers);
      assert.equal(/rel="api-catalog"/.test(headers), !off, headers);
      assert.match(headers, /rel="service-doc"/);
    } finally {
      await rm(site.root, { recursive: true, force: true });
    }
  }
});

test("off with a skills/ folder: the build warns only when the skills land at the origin root", async () => {
  const skills = { "deploy/SKILL.md": "---\nname: deploy\ndescription: Deploy with Wrangler.\n---\nSteps.\n" };
  const warning = /agents\.discovery is false, but skills\/ still publishes \/\.well-known\/agent-skills\/ at the origin root/;
  const cases = [
    { name: "off, Cloudflare under a base", off: true, cloudflare: true, warns: true },
    { name: "off, other host under a base", off: true, cloudflare: false, warns: false },
    { name: "on, Cloudflare under a base", off: false, cloudflare: true, warns: false },
  ];
  for (const { name, off, cloudflare, warns } of cases) {
    const site = await discoveryFixture(undefined, "docs", false, skills, off ? OFF : {});
    try {
      await site.write("server-entry.mjs", 'import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n');
      const config = cloudflare
        ? {
            ...site.config,
            output: "server",
            adapter: cloudflareNamed(path.join(site.root, "server-entry.mjs")),
            build: { client: path.join(site.root, "out/docs"), server: path.join(site.root, ".server") },
          }
        : site.config;
      const log = await captured(() => build({ ...config, logLevel: "info" } as never));
      assert.equal(warning.test(log), warns, `${name}\n${log}`);
    } finally {
      await rm(site.root, { recursive: true, force: true });
    }
  }
});

test("astro dev answers no discovery path when off, and serves the site's own file", async () => {
  for (const base of ["/", "/docs"]) {
    const site = await discoveryFixture(undefined, "docs", true, undefined, OFF);
    await site.write("public/.well-known/ard.json", OWN_ARD);
    const server = await dev({ ...site.config, base, server: { host: "127.0.0.1", port: 0 } });
    try {
      const origin = `http://127.0.0.1:${server.address.port}`;
      const own = base === "/" ? "/.well-known/ard.json" : "/docs/.well-known/ard.json";
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(origin + own, { method });
        assert.equal(response.status, 200, `${method} ${own}`);
        if (method === "GET") assert.equal(await response.text(), OWN_ARD);
        for (const pathname of ["/.well-known/api-catalog", "/.well-known/ai-catalog.json", ...(base === "/" ? [] : ["/.well-known/ard.json"])]) {
          const missing = await fetch(origin + pathname, { method, redirect: "manual" });
          // At the root Vite serves public/ and 404s the rest; under a base,
          // origin-root paths outside it are never 200 (Astro 404s or redirects).
          if (base === "/") assert.equal(missing.status, 404, `${method} ${pathname}`);
          else assert.ok([301, 302, 307, 308, 404].includes(missing.status), `${method} ${pathname} under ${base}: ${missing.status}`);
        }
      }
    } finally {
      await server.stop();
      await rm(site.root, { recursive: true, force: true });
    }
  }
});

test("static _headers and request-rendered homepages get the same links, without discovery when off", () => {
  const capabilities = createAgentCapabilities({
    llmsUrl: "https://example.test/docs/llms.txt",
    apis: [{ collection: "pets", docsUrl: "https://example.test/docs/pets/", spec: { url: "https://example.test/docs/pets/openapi.json", type: "application/vnd.oai.openapi+json" } }],
  });
  const options = { site: "https://example.test", title: "Example", base: "/docs", output: "server" as const };
  const on = agentHomepageLinks(capabilities, options);
  const off = agentHomepageLinks(capabilities, { ...options, discovery: false });
  assert.deepEqual(off, on.filter((link) => !/rel="(ard|api-catalog)"/.test(link)));
  assert.equal(on.length - off.length, 2);
  const rules = agentDiscoveryHeaderRules(capabilities, { ...options, discovery: false });
  assert.doesNotMatch(rules, DISCOVERY_RULES);
  for (const link of off) assert.ok(rules.includes(link), link);
});

test("off with several API versions: only each default's links, without the catalog", () => {
  const api = (version: string, isDefault: boolean) => ({
    collection: "pets",
    version,
    ...(isDefault ? {} : { isDefault: false }),
    docsUrl: `https://example.test/docs/pets/${isDefault ? "" : `${version}/`}`,
    spec: { url: `https://example.test/docs/pets/${isDefault ? "" : `${version}/`}openapi.json`, type: "application/json" },
  });
  const capabilities = createAgentCapabilities({ apis: [api("v1", false), api("v2", true), api("v0", false)] });
  const links = agentHomepageLinks(capabilities, {
    site: "https://example.test",
    title: "Example",
    base: "/docs",
    output: "server",
    discovery: false,
  });
  assert.deepEqual(links.filter((link) => /rel="service-/.test(link)), [
    '<https://example.test/docs/pets/>; rel="service-doc"; type="text/html"',
    '<https://example.test/docs/pets/openapi.json>; rel="service-desc"; type="application/json"',
  ]);
  assert.doesNotMatch(links.join("\n"), /rel="(ard|api-catalog)"/);
});
