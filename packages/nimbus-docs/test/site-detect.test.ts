import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import nimbus from "../src/index.js";
import { resolveSite } from "../src/_internal/site-detect.js";

const PLACEHOLDER = "https://example.com";

function run(
  env: Record<string, string | undefined>,
  opts: { configuredSite?: string; cloudflareSignal?: boolean } = {},
) {
  return resolveSite({
    configuredSite: opts.configuredSite ?? PLACEHOLDER,
    env,
    cloudflareSignal: opts.cloudflareSignal ?? false,
  });
}

test("explicit non-placeholder site always wins, no warning, even on a platform", () => {
  const r = run(
    {
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "prod.vercel.app",
    },
    { configuredSite: "https://docs.acme.com" },
  );
  assert.deepEqual(r, {
    site: "https://docs.acme.com",
    adopted: false,
    warning: null,
  });
});

test("Vercel production adopts VERCEL_PROJECT_PRODUCTION_URL (https-normalized)", () => {
  const r = run({
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "docs.acme.com",
  });
  assert.equal(r.site, "https://docs.acme.com");
  assert.equal(r.adopted, true);
  assert.equal(r.warning, null);
});

test("Vercel preview warns without adopting", () => {
  const r = run({
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_PROJECT_PRODUCTION_URL: "docs.acme.com",
    VERCEL_URL: "deploy-xyz.vercel.app",
  });
  assert.equal(r.site, PLACEHOLDER);
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /Vercel preview/);
});

test("Vercel production with missing var warns without adopting", () => {
  const r = run({ VERCEL: "1", VERCEL_ENV: "production" });
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /VERCEL_PROJECT_PRODUCTION_URL/);
});

test("a whitespace-only platform var is treated as missing, not normalized to https://", () => {
  const r = run({
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "   ",
  });
  assert.equal(r.adopted, false);
  assert.equal(r.site, PLACEHOLDER);
  assert.match(r.warning ?? "", /VERCEL_PROJECT_PRODUCTION_URL/);
});

test("Netlify production adopts URL", () => {
  const r = run({
    NETLIFY: "true",
    CONTEXT: "production",
    URL: "https://acme.netlify.app",
  });
  assert.equal(r.site, "https://acme.netlify.app");
  assert.equal(r.adopted, true);
});

test("Netlify deploy alias (branch-deploy) warns without adopting", () => {
  const r = run({
    NETLIFY: "true",
    CONTEXT: "branch-deploy",
    URL: "https://acme.netlify.app",
    DEPLOY_PRIME_URL: "https://feat--acme.netlify.app",
  });
  assert.equal(r.site, PLACEHOLDER);
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /Netlify preview/);
});

test("Netlify deploy-preview also warns without adopting", () => {
  const r = run({
    NETLIFY: "true",
    CONTEXT: "deploy-preview",
    URL: "https://acme.netlify.app",
    DEPLOY_PRIME_URL: "https://deploy-preview-7--acme.netlify.app",
  });
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /Netlify preview/);
});

test("Netlify production with missing URL warns without adopting", () => {
  const r = run({ NETLIFY: "true", CONTEXT: "production" });
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /URL/);
});

test("Cloudflare Pages with missing CF_PAGES_URL warns without adopting", () => {
  const r = run({ CF_PAGES: "1" });
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /CF_PAGES_URL/);
});

test("Cloudflare Pages adopts CF_PAGES_URL with a preview caveat", () => {
  const r = run({ CF_PAGES: "1", CF_PAGES_URL: "https://acme.pages.dev" });
  assert.equal(r.site, "https://acme.pages.dev");
  assert.equal(r.adopted, true);
  assert.match(r.warning ?? "", /Cloudflare Pages/);
});

test("bare Cloudflare Workers (signal, no env) warns loudly, no adopt", () => {
  const r = run({}, { cloudflareSignal: true });
  assert.equal(r.site, PLACEHOLDER);
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /Cloudflare Workers/);
});

test("no platform + placeholder warns about example.com", () => {
  const r = run({});
  assert.equal(r.site, PLACEHOLDER);
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /example\.com/);
});

test("trailing slash is stripped on adopt", () => {
  const r = run({ CF_PAGES: "1", CF_PAGES_URL: "https://acme.pages.dev/" });
  assert.equal(r.site, "https://acme.pages.dev");
});

test("*.example.com is also treated as a placeholder", () => {
  const r = run({}, { configuredSite: "https://docs.example.com" });
  assert.equal(r.adopted, false);
  assert.match(r.warning ?? "", /example\.com/);
});

async function buildSiteWarnings(adapter: string | undefined): Promise<string[]> {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-site-signal-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "wrangler.jsonc"), "{}\n");
  const warnings: string[] = [];
  const logger = { warn: (m: string) => warnings.push(m), info() {}, error() {}, debug() {}, fork: () => logger };
  const dir = (p: string) => pathToFileURL(p + path.sep);
  const integration = nimbus(
    { site: PLACEHOLDER, title: "T", description: "D", locale: "en" } as never,
    { validateMdx: false, admonitions: false, sitemap: false, markdown: { processor: {} as never } },
  );
  await integration.hooks["astro:config:setup"]!({
    command: "build",
    injectRoute() {},
    addMiddleware() {},
    updateConfig: () => ({}) as never,
    config: {
      root: dir(root),
      srcDir: dir(path.join(root, "src")),
      cacheDir: dir(path.join(root, ".cache")),
      base: "",
      build: { format: "directory" },
      adapter: adapter ? { name: adapter } : undefined,
    },
    logger,
  } as never);
  return warnings.filter((m) => m.includes("`site`"));
}

test("a leftover wrangler config names Cloudflare only when no other adapter is configured", async () => {
  for (const adapter of [undefined, "@astrojs/cloudflare"]) {
    assert.match((await buildSiteWarnings(adapter)).join("\n"), /Cloudflare Workers/, String(adapter));
  }
  for (const adapter of ["@astrojs/node", "@astrojs/vercel", "@astrojs/netlify"]) {
    const [warning, ...rest] = await buildSiteWarnings(adapter);
    assert.deepEqual(rest, [], adapter);
    assert.doesNotMatch(warning ?? "", /Cloudflare/, adapter);
    assert.match(warning ?? "", /is the placeholder/, adapter);
  }
});
