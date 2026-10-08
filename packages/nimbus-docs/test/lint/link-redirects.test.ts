/**
 * Redirect resolution for `nimbus/internal-link` and `nimbus/redirected-link`
 * (`link-resolver.ts`), plus the `_redirects` parser the build uses.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseRedirectsFile } from "../../src/_internal/redirects-file.js";
import type { RulesConfig } from "../../src/lint/config.js";
import { lintFile } from "../../src/lint/engine.js";
import { _resetLinkEnvCacheForTests } from "../../src/lint/link-env.js";
import { parseSource } from "../../src/lint/parse.js";
import { ROUTE_TRUTH_VERSION, type RouteTruth } from "../../src/lint/site-model.js";

type Redirect = RouteTruth["redirects"][number];

const FM = `---
title: Test
description: A description for the test page.
---
`;

function r(from: string, to: string, status = 301, force = false): Redirect {
  return { from, to, status, ...(force ? { force } : {}) };
}

function lint(
  truth: {
    knownRoutes: string[];
    redirects: Redirect[];
    base?: string;
    redirectRules?: RouteTruth["redirectRules"];
    redirectPages?: RouteTruth["redirectPages"];
  },
  body: string,
  rules: RulesConfig = { "nimbus/internal-link": "error", "nimbus/redirected-link": "warn" },
  frontmatter = FM,
  site?: string,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-redir-"));
  try {
    fs.mkdirSync(path.join(root, ".nimbus"), { recursive: true });
    const full: RouteTruth = {
      version: ROUTE_TRUTH_VERSION,
      base: truth.base ?? "",
      knownRoutes: truth.knownRoutes,
      redirects: truth.redirects,
      redirectPages: truth.redirectPages ?? [],
      redirectRules: truth.redirectRules ?? "cloudflare",
      opaqueNamespaces: [],
    };
    fs.writeFileSync(path.join(root, ".nimbus", "routes.json"), JSON.stringify(full));
    _resetLinkEnvCacheForTests();
    const parsed = parseSource(`${frontmatter}\n${body}\n`, {
      path: "src/content/docs/page.mdx",
      absPath: path.join(root, "src/content/docs/page.mdx"),
      collection: "docs",
    });
    return lintFile(parsed, { rules, site }).map((d) => ({ code: d.code, message: d.message }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const errors = (diags: { code: string; message: string }[]) =>
  diags.filter((d) => d.code === "nimbus/internal-link").map((d) => d.message);
const redirected = (diags: { code: string; message: string }[]) =>
  diags.filter((d) => d.code === "nimbus/redirected-link").map((d) => d.message);

// ---------------------------------------------------------------------------
// Following the chain
// ---------------------------------------------------------------------------

test("a splat redirect to a built page is valid and reported as redirected", () => {
  const diags = lint(
    {
      knownRoutes: ["/sandbox/sdk/api/backups"],
      redirects: [r("/sandbox/api/*", "/sandbox/sdk/api/:splat")],
    },
    "[Backups](/sandbox/api/backups/)",
  );
  assert.deepEqual(errors(diags), []);
  assert.deepEqual(redirected(diags), [
    `"/sandbox/api/backups/" redirects to "/sandbox/sdk/api/backups/" — link to the destination directly.`,
  ]);
});

test("a splat redirect to a missing page is broken and names the destination", () => {
  const diags = lint(
    {
      knownRoutes: ["/sandbox/sdk/api/backups"],
      redirects: [r("/sandbox/api/*", "/sandbox/sdk/api/:splat")],
    },
    "[Nope](/sandbox/api/nope/)",
  );
  assert.deepEqual(errors(diags), [
    `broken link "/sandbox/api/nope/" — redirects to "/sandbox/sdk/api/nope/", which no page resolves to.`,
  ]);
  assert.deepEqual(redirected(diags), []);
});

test("a redirect to another site is valid", () => {
  const diags = lint(
    { knownRoutes: ["/"], redirects: [r("/old/", "https://example.com/new/")] },
    "[Old](/old/)",
  );
  assert.deepEqual(errors(diags), []);
});

test("a redirect loop is broken", () => {
  const diags = lint(
    { knownRoutes: ["/"], redirects: [r("/a/", "/b/"), r("/b/", "/a/")] },
    "[A](/a/)",
  );
  assert.equal(errors(diags).length, 1);
  assert.match(errors(diags)[0]!, /redirect loop/);
});

test("a chain of more than 20 hops is broken; 20 is fine", () => {
  const chain = (n: number) =>
    Array.from({ length: n }, (_, i) => r(`/h${i}/`, `/h${i + 1}/`));
  const ok = lint({ knownRoutes: ["/h20"], redirects: chain(20) }, "[H](/h0/)");
  assert.deepEqual(errors(ok), []);
  const tooLong = lint({ knownRoutes: ["/h21"], redirects: chain(21) }, "[H](/h0/)");
  assert.match(errors(tooLong)[0]!, /more than 20 redirects/);
});

test("a redirect source wins over a file at the same path, and the chain continues", () => {
  // `/b` exists as a file (Astro's meta-refresh page), but it's also a source.
  const diags = lint(
    { knownRoutes: ["/b", "/c"], redirects: [r("/a/", "/b/"), r("/b/", "/c/")] },
    "[A](/a/)",
  );
  assert.deepEqual(errors(diags), []);
  assert.deepEqual(redirected(diags), [
    `"/a/" redirects to "/c/" — link to the destination directly.`,
  ]);
  const missing = lint(
    { knownRoutes: ["/b"], redirects: [r("/a/", "/b/"), r("/b/", "/c/")] },
    "[A](/a/)",
  );
  assert.match(errors(missing)[0]!, /no page resolves to the last one/);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test("a temporary redirect to a missing page is broken; to a built page, silent", () => {
  const missing = lint(
    { knownRoutes: ["/"], redirects: [r("/latest/", "/deleted/", 302)] },
    "[Latest](/latest/)",
  );
  assert.deepEqual(errors(missing), [
    `broken link "/latest/" — redirects to "/deleted/", which no page resolves to.`,
  ]);
  const built = lint(
    { knownRoutes: ["/deleted"], redirects: [r("/latest/", "/deleted/", 302)] },
    "[Latest](/latest/)",
  );
  assert.deepEqual(built, []);
});

test("permanent then temporary: redirected-link names the stable middle URL", () => {
  const redirects = [r("/a/", "/b/", 301), r("/b/", "/c/", 302)];
  const ok = lint({ knownRoutes: ["/c"], redirects }, "[A](/a/)");
  assert.deepEqual(errors(ok), []);
  assert.deepEqual(redirected(ok), [`"/a/" redirects to "/b/" — link to the destination directly.`]);
  const broken = lint({ knownRoutes: [], redirects }, "[A](/a/)");
  assert.match(errors(broken)[0]!, /"\/b\/" → "\/c\/"/);
  assert.deepEqual(redirected(broken), []);
});

test("an exact 200 source is a rewrite; a pattern 200 source doesn't validate links", () => {
  assert.deepEqual(
    lint({ knownRoutes: [], redirects: [r("/app/", "/index.html", 200)] }, "[App](/app/)"),
    [],
  );
  const spa = lint(
    { knownRoutes: ["/"], redirects: [r("/*", "/index.html", 200)] },
    "[Nope](/nope/)",
  );
  assert.equal(errors(spa).length, 1);
});

test("redirects are matched under base, and links are written without it", () => {
  const diags = lint(
    {
      base: "/docs",
      knownRoutes: ["/new"],
      redirects: [r("/docs/old/", "/docs/new/"), r("/elsewhere/", "/nowhere/")],
    },
    "[Old](/old/) and [Else](/elsewhere/)",
  );
  // `/elsewhere/` is outside base, so no link can reach that rule.
  assert.equal(errors(diags).length, 1);
  assert.match(errors(diags)[0]!, /"\/elsewhere\/"/);
});

test("redirected-link is off by default, honors its ignore, and skips drafts", () => {
  const truth = { knownRoutes: ["/b"], redirects: [r("/a/", "/b/")] };
  assert.deepEqual(lint(truth, "[A](/a/)", { "nimbus/internal-link": "error" }), []);
  assert.deepEqual(
    lint(truth, "[A](/a/)", { "nimbus/redirected-link": ["warn", { ignore: ["/a"] }] }),
    [],
  );
  assert.deepEqual(
    lint(truth, "[A](/a/)", { "nimbus/redirected-link": "warn" }, `---\ntitle: T\ndraft: true\n---\n`),
    [],
  );
});

// ---------------------------------------------------------------------------
// `_redirects` syntax
// ---------------------------------------------------------------------------

test("parseRedirectsFile: status default, force suffix, comments, conditions, malformed", () => {
  const parsed = parseRedirectsFile(
    [
      "# comment",
      "",
      "/a /b",
      "/c /d 302!",
      "/e /f 301 Country=us",
      "/lonely",
      "/g /h nope",
    ].join("\n"),
    302,
  );
  assert.deepEqual(parsed.redirects, [
    { from: "/a", to: "/b", status: 302 },
    { from: "/c", to: "/d", status: 302, force: true },
  ]);
  assert.equal(parsed.malformed, 2);
});

test("placeholders match one segment and fill the destination", () => {
  const redirects = [r("/blog/:year/:slug/", "/posts/:slug/")];
  const diags = lint({ knownRoutes: ["/posts/hello"], redirects }, "[Post](/blog/2026/hello/)");
  assert.deepEqual(errors(diags), []);
  const deeper = lint({ knownRoutes: ["/posts/hello"], redirects }, "[Post](/blog/2026/x/hello/)");
  assert.equal(errors(deeper).length, 1);
});

// ---------------------------------------------------------------------------
// Design review (2026-10-02) reproductions
// ---------------------------------------------------------------------------

test("a canonical trailing-slash redirect is not a loop", () => {
  const diags = lint(
    { knownRoutes: ["/guide"], redirects: [r("/guide", "/guide/")] },
    "[a](/guide) and [b](/guide/)",
  );
  assert.deepEqual(errors(diags), []);
  assert.deepEqual(redirected(diags), [
    `"/guide" redirects to "/guide/" — link to the destination directly.`,
  ]);
});

test("sources match exactly: a link without the source's trailing slash is broken, with a hint", () => {
  const diags = lint(
    { knownRoutes: ["/new"], redirects: [r("/old/", "/new/")] },
    "[Old](/old)",
  );
  assert.deepEqual(errors(diags), [
    `broken link "/old" — no page resolves to this path, but a redirect is defined for "/old/".`,
  ]);
});

test("a redirect that removes the trailing slash is not a loop", () => {
  const diags = lint(
    { knownRoutes: ["/guide"], redirects: [r("/guide/", "/guide")] },
    "[a](/guide/) and [b](/guide)",
  );
  assert.deepEqual(errors(diags), []);
});

test("the incoming query passes through a redirect without its own", () => {
  const diags = lint(
    { knownRoutes: ["/api/download", "/b"], redirects: [r("/download", "/api/download"), r("/a", "/b?x=1")] },
    "[d](/download?id=42) and [a](/a?y=2)",
  );
  assert.deepEqual(redirected(diags), [
    `"/download?id=42" redirects to "/api/download?id=42" — link to the destination directly.`,
    `"/a?y=2" redirects to "/b?x=1" — link to the destination directly.`,
  ]);
});

test("a destination outside base is suggested as an absolute URL on site, or not at all", () => {
  const truth = { base: "/docs", knownRoutes: [], redirects: [r("/docs/old", "/login")] };
  const rules: RulesConfig = { "nimbus/internal-link": "error", "nimbus/redirected-link": "warn" };
  assert.deepEqual(redirected(lint(truth, "[Old](/old)", rules, FM, "https://example.com/docs")), [
    `"/old" redirects to "https://example.com/login" — link to the destination directly.`,
  ]);
  assert.deepEqual(lint(truth, "[Old](/old)", rules), []);
});

test("splat captures stay encoded", () => {
  const diags = lint(
    { knownRoutes: ["/api/a#b", "/api/a"], redirects: [r("/old/*", "/api/:splat")] },
    "[x](/old/a%23b)",
    { "nimbus/internal-link": "error", "nimbus/redirected-link": "warn" },
  );
  assert.deepEqual(redirected(diags), [
    `"/old/a%23b" redirects to "/api/a%23b" — link to the destination directly.`,
  ]);
});

test("redirected-link suggests the destination without base", () => {
  const diags = lint(
    { base: "/docs", knownRoutes: ["/new"], redirects: [r("/docs/old/", "/docs/new/")] },
    "[Old](/old/)",
  );
  assert.deepEqual(redirected(diags), [
    `"/old/" redirects to "/new/" — link to the destination directly.`,
  ]);
});

test("redirected-link reports a chain that ends at a path internal-link ignores", () => {
  const diags = lint(
    { knownRoutes: [], redirects: [r("/old/", "/ignored/")] },
    "[Old](/old/)",
    {
      "nimbus/internal-link": ["error", { ignore: ["/ignored"] }],
      "nimbus/redirected-link": "warn",
    },
  );
  assert.deepEqual(errors(diags), []);
  assert.deepEqual(redirected(diags), [
    `"/old/" redirects to "/ignored/" — link to the destination directly.`,
  ]);
});

// ---------------------------------------------------------------------------
// Platform semantics and base (third review, 2026-10-03)
// ---------------------------------------------------------------------------

test("netlify: a source matches with or without its trailing slash", () => {
  const diags = lint(
    { redirectRules: "netlify", knownRoutes: ["/new"], redirects: [r("/old/", "/new/")] },
    "[a](/old) and [b](/old/)",
  );
  assert.deepEqual(errors(diags), []);
  assert.equal(redirected(diags).length, 2);
});

test("netlify: a trailing-slash redirect over a built page is shadowed, not a loop", () => {
  const diags = lint(
    { redirectRules: "netlify", knownRoutes: ["/guide"], redirects: [r("/guide/", "/guide")] },
    "[a](/guide/) and [b](/guide)",
  );
  assert.deepEqual(diags, []);
});

test("netlify: an unforced rule doesn't apply over a built page; a forced one does", () => {
  const shadowed = lint(
    { redirectRules: "netlify", knownRoutes: ["/page"], redirects: [r("/page", "/missing")] },
    "[p](/page)",
  );
  assert.deepEqual(shadowed, []);
  const forced = lint(
    { redirectRules: "netlify", knownRoutes: ["/page"], redirects: [r("/page", "/missing", 301, true)] },
    "[p](/page)",
  );
  assert.match(errors(forced)[0]!, /redirects to "\/missing"/);
});

test("cloudflare: a redirect applies over a built page", () => {
  const diags = lint({ knownRoutes: ["/page"], redirects: [r("/page", "/missing")] }, "[p](/page)");
  assert.match(errors(diags)[0]!, /redirects to "\/missing"/);
});

test("a query on the base root stays inside base and is followed", () => {
  const diags = lint(
    {
      base: "/docs",
      knownRoutes: [],
      redirects: [r("/docs/old", "/docs?lang=en"), r("/docs", "/docs/missing")],
    },
    "[Old](/old)",
  );
  assert.match(errors(diags)[0]!, /"\/docs\?lang=en" → "\/docs\/missing\?lang=en", and no page resolves/);
});

test("netlify: Astro's redirect page sends the browser to its destination", () => {
  const page = (from: string, to: string) => ({ from, to, status: 301 });
  const missing = lint(
    { redirectRules: "netlify", knownRoutes: ["/old"], redirects: [], redirectPages: [page("/old", "/missing")] },
    "[Old](/old)",
  );
  assert.deepEqual(errors(missing), [
    `broken link "/old" — redirects to "/missing", which no page resolves to.`,
  ]);
  const built = lint(
    {
      redirectRules: "netlify",
      knownRoutes: ["/old", "/new"],
      redirects: [],
      redirectPages: [page("/old", "/new")],
    },
    "[Old](/old)",
  );
  assert.deepEqual(errors(built), []);
  assert.deepEqual(redirected(built), [`"/old" redirects to "/new" — link to the destination directly.`]);
});

test("an unforced rule over Astro's redirect page: Netlify serves the page, Cloudflare applies the rule", () => {
  const truth = {
    knownRoutes: ["/old", "/good"],
    redirects: [r("/old", "/good")],
    redirectPages: [{ from: "/old", to: "/missing", status: 301 }],
  };
  assert.match(errors(lint({ ...truth, redirectRules: "netlify" }, "[Old](/old)"))[0]!, /"\/missing"/);
  assert.deepEqual(errors(lint({ ...truth, redirectRules: "cloudflare" }, "[Old](/old)")), []);
  const forced = { ...truth, redirects: [r("/old", "/good", 301, true)], redirectRules: "netlify" as const };
  assert.deepEqual(errors(lint(forced, "[Old](/old)")), []);
});
