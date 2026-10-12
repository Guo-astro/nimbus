import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createAgentCapabilities } from "../src/_internal/agent-capabilities.js";
import {
  agentDiscoveryManifest,
  agentHomepageLinks,
  agentDiscoveryHeaderRules,
  appendAgentDiscoveryHeaders,
} from "../src/_internal/agent-discovery.js";

const options = {
  site: "https://docs.example.com",
  title: "Example",
  base: "/docs/",
};
const minimal = createAgentCapabilities({
  llmsUrl: `${options.site}/docs/llms.txt`,
  homepageMarkdownUrl: `${options.site}/docs/index.md`,
});
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const schema = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `./fixtures/agent-discovery/${name}.schema.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const ard = schema("ard-entry");
ajv.addSchema(ard);
const validateArd = ajv.compile({ $ref: `${ard.$id}#/$defs/ArdManifest` });
const validateCatalog = ajv.compile(schema("ai-catalog"));

test("minimal discovery validates against both pinned schemas and matches the fixture", () => {
  const document = agentDiscoveryManifest(minimal, options);
  for (const validate of [validateArd, validateCatalog])
    assert.equal(validate(document), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    document,
    JSON.parse(
      readFileSync(
        new URL("./fixtures/agent-discovery/docs-only.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(
    document.entries.map((entry) => entry.type),
    ["text/plain", "text/markdown"],
  );
  assert.equal(agentHomepageLinks(minimal, options).length, 3);
});

test("discovery and API documentation links exclude hidden collections", () => {
  const capabilities = createAgentCapabilities({
    llmsUrl: minimal.llmsUrl,
    homepageMarkdownUrl: minimal.homepageMarkdownUrl,
    apis: [
      {
        collection: "pets",
        docsUrl: `${options.site}/docs/pets/`,
        markdownUrl: `${options.site}/docs/pets/index.md`,
      },
      {
        collection: "private",
        docsUrl: `${options.site}/private/`,
        markdownUrl: `${options.site}/private/index.md`,
        hidden: true,
      },
    ],
  });
  assert.equal(agentDiscoveryManifest(capabilities, options).entries.length, 2);
  const links = agentHomepageLinks(capabilities, options).join(", ");
  assert.match(links, /service-doc/);
  assert.match(links, /api-catalog/);
  // No published spec, so no service-desc; hidden collections appear nowhere.
  assert.doesNotMatch(links, /service-desc|private/);
  assert.doesNotMatch(
    JSON.stringify(agentDiscoveryManifest(capabilities, options)),
    /mcp|skills|private/,
  );
});

test("discovery identifiers distinguish base paths and normalize trailing slashes", () => {
  const document = agentDiscoveryManifest(minimal, options);
  const normalised = agentDiscoveryManifest(minimal, {
    ...options,
    base: "/docs",
  });
  const other = agentDiscoveryManifest(minimal, {
    ...options,
    base: "/handbook",
  });
  assert.deepEqual(document.entries, normalised.entries);
  assert.notEqual(
    document.entries[0]?.identifier,
    other.entries[0]?.identifier,
  );
});

test("header generation preserves owner bytes and applies only to bounded exact paths", () => {
  const owner =
    "/custom\n  Cache-Control: private\n/\n  Link: <https://example.net/>; rel=help";
  const generated = agentDiscoveryHeaderRules(minimal, options);
  assert.ok(
    appendAgentDiscoveryHeaders(owner, generated).startsWith(owner + "\n\n"),
  );
  assert.match(generated, /^\/docs\/\n  Link: /m);
  assert.match(generated, /^\/docs\n  Link: /m);
  assert.match(
    generated,
    /^\/\.well-known\/ard.json\n  Content-Type: application\/json\n  Access-Control-Allow-Origin: \*/m,
  );
  assert.match(
    generated,
    /^\/docs\/index.md\n  Content-Type: text\/markdown; charset=utf-8/m,
  );
  assert.equal((generated.match(/rel="ard"/g) ?? []).length, 2);
});

test("homepage Markdown remains addressable but noindex removes its discovery links", () => {
  const capabilities = { ...minimal, homepageDiscoverable: false };
  assert.deepEqual(
    agentDiscoveryManifest(capabilities, options).entries.map(
      (entry) => entry.type,
    ),
    ["text/plain"],
  );
  assert.doesNotMatch(
    agentHomepageLinks(capabilities, options).join(", "),
    /alternate|index.md/,
  );
  assert.match(
    agentDiscoveryHeaderRules(capabilities, options),
    /index.md\n  Content-Type/,
  );
});

test("regenerating headers does not duplicate Nimbus's block or lose owner lines", () => {
  const generated = agentDiscoveryHeaderRules(minimal, options);
  for (const owner of [
    "",
    "/custom\n  X-Owner: yes",
    "/custom\n  X-Owner: yes\n",
  ]) {
    const once = appendAgentDiscoveryHeaders(owner, generated);
    assert.equal(appendAgentDiscoveryHeaders(once, generated), once);
    assert.ok(once.startsWith(owner));
  }
});

test("discovery headers share existing exact-path rules without replacing owner fields", () => {
  for (const base of ["/", "/docs"]) {
    for (const newline of ["\n", "\r\n"]) {
      const home = base === "/" ? "/" : "/docs/";
      const owner = [
        "# Owner policy",
        "/*",
        "  X-Global: retained",
        home,
        '  Link: <https://owner.example/policy>; rel="author"',
        "  X-Owner: retained",
        "",
        "/custom",
        "  Cache-Control: private",
        "",
      ].join(newline);
      const settings = { ...options, base };
      const generated = agentDiscoveryHeaderRules(minimal, settings);
      const merged = appendAgentDiscoveryHeaders(owner, generated);
      const paths = merged.split(/\r?\n/).filter((line) => line === home);
      assert.equal(paths.length, 1);
      const block = merged.slice(
        merged.indexOf(`${home}${newline}`),
        merged.indexOf("/custom"),
      );
      assert.match(block, /rel="author"/);
      assert.match(block, /rel="ard"/);
      assert.match(block, /X-Owner: retained/);
      assert.match(merged, /X-Global: retained/);
      assert.match(merged, /Cache-Control: private/);
      assert.equal(appendAgentDiscoveryHeaders(merged, generated), merged);
      const updated = appendAgentDiscoveryHeaders(
        merged,
        agentDiscoveryHeaderRules(
          { ...minimal, homepageDiscoverable: false },
          settings,
        ),
      );
      assert.match(updated, /rel="author"/);
      assert.doesNotMatch(updated, /rel="alternate"/);
      assert.equal(
        updated.split(/\r?\n/).filter((line) => line === home).length,
        1,
      );
    }
  }
});

test("many API versions get separate bounded Link lines with unchanged header values", () => {
  const capabilities = createAgentCapabilities({
    ...minimal,
    apis: Array.from({ length: 30 }, (_, version) => ({
      collection: "pets",
      version: `v${version}`,
      docsUrl: `${options.site}/docs/pets/v${version}/`,
      markdownUrl: `${options.site}/docs/pets/v${version}/index.md`,
    })),
  });
  const values = agentHomepageLinks(capabilities, options);
  assert.ok(
    values.join(", ").length > 2000,
    "fixture must exceed the old line limit",
  );
  const block = agentDiscoveryHeaderRules(capabilities, options)
    .split("\n\n")
    .find((rule) => rule.startsWith("/docs/\n"))!;
  const lines = block.split("\n").slice(1);
  assert.equal(lines.length, values.length);
  assert.ok(lines.every((line) => line.length <= 2000));
  const served = new Headers();
  for (const line of lines) {
    assert.ok(line.startsWith("  Link: "));
    served.append("Link", line.slice("  Link: ".length));
  }
  assert.equal(served.get("Link"), values.join(", "));
});

test("base namespaces escape once, retain segment identity, and validate against both schemas", () => {
  const cases = [
    ["/", "docs"],
    ["/docs", "docs-docs"],
    ["/my docs/v2", "docs-my_20docs-v2"],
    ["/my%20docs/v2", "docs-my_20docs-v2"],
    ["/a/b", "docs-a-b"],
    ["/a-b", "docs-a_2Db"],
    ["/a_2Db", "docs-a_5F2Db"],
    ["/a%2Fb", "docs-a_2Fb"],
    ["/café", "docs-caf_C3_A9"],
    ["/a//b", "docs-a--b"],
  ];
  for (const [base, namespace] of cases) {
    const document = agentDiscoveryManifest(minimal, {
      ...options,
      base: base!,
    });
    assert.equal(
      document.entries[0]?.identifier,
      `urn:air:docs.example.com:${namespace}:index`,
    );
    for (const validate of [validateArd, validateCatalog])
      assert.equal(
        validate(document),
        true,
        `${base}: ${JSON.stringify(validate.errors)}`,
      );
  }
});

test("browser search capabilities follow the provider and exclude hidden versions", () => {
  assert.equal(createAgentCapabilities({}).search, "pagefind");
  assert.equal(
    createAgentCapabilities({ search: { provider: "pagefind" } }).search,
    "pagefind",
  );
  assert.equal(
    createAgentCapabilities({ search: false }).search,
    "unavailable",
  );
  assert.equal(
    createAgentCapabilities({ search: { provider: "custom" } }).search,
    "unavailable",
  );
  assert.deepEqual(
    createAgentCapabilities({
      versions: [
        { name: "current" },
        { name: "old" },
        { name: "private", hidden: true },
        { name: "current" },
      ],
    }).versions,
    ["current", "old"],
  );
});

test("agent text header rules stay bounded as the number of emitted pages grows", () => {
  const paths = [
    "/llms.txt",
    "/llms-full.txt",
    "/robots.txt",
    "/setup/llms.txt",
    ...Array.from({ length: 400 }, (_, index) => `/guide/${index}/index.md`),
  ];
  const generated = agentDiscoveryHeaderRules(minimal, options, [], { paths });
  for (const rule of [
    "/docs/llms.txt",
    "/docs/llms-full.txt",
    "/docs/robots.txt",
    "/docs/*/llms.txt",
    "/docs/*/index.md",
  ])
    assert.ok(
      generated.includes(
        `${rule}\n  Content-Type: text/${rule.endsWith(".md") ? "markdown" : "plain"}; charset=utf-8`,
      ),
      rule,
    );
  assert.equal(
    generated.split("\n").filter((line) => line.startsWith("/")).length,
    10,
  );
  assert.doesNotMatch(generated, /^\/docs\/\*\.(md|txt)$/m);
  assert.doesNotMatch(
    agentDiscoveryHeaderRules(minimal, options, [], { paths: [] }),
    /llms.txt\n  Content-Type|\*\/index.md|robots.txt\n/,
  );
});

test("owner Content-Type rules take precedence without comma-joining generated text types", () => {
  const paths = [
    "/llms.txt",
    "/llms-full.txt",
    "/guide/index.md",
    "/setup/start/index.md",
  ];
  for (const newline of ["\n", "\r\n"]) {
    const ownerHeaders = [
      "/*.txt",
      "  Content-Type: text/plain; charset=utf-8",
      "",
      "/*.md",
      "  content-type: text/markdown; charset=utf-8",
      "",
    ].join(newline);
    const generated = agentDiscoveryHeaderRules(minimal, options, [], {
      paths,
      ownerHeaders,
    });
    assert.doesNotMatch(generated, /Content-Type: text\/(plain|markdown)/);
    const merged = appendAgentDiscoveryHeaders(ownerHeaders, generated);
    assert.ok(merged.startsWith(ownerHeaders));
    assert.equal(appendAgentDiscoveryHeaders(merged, generated), merged);
  }
  const warnings: string[] = [];
  const generated = agentDiscoveryHeaderRules(minimal, options, [], {
    paths,
    ownerHeaders:
      "/docs/guide/index.md\n  Content-Type: application/octet-stream\n/docs/index.md\n  Content-Type: text/plain",
    warn: (message) => warnings.push(message),
  });
  assert.doesNotMatch(generated, /Content-Type: text\/markdown/);
  assert.match(
    generated,
    /\/docs\/llms.txt\n  Content-Type: text\/plain; charset=utf-8/,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\/docs\/\*\/index.md/);
  for (const pattern of [
    "/docs/:section/index.md",
    "https://preview.example.com/docs/*.md",
  ]) {
    const generated = agentDiscoveryHeaderRules(minimal, options, [], {
      paths,
      ownerHeaders: `${pattern}\n  Content-Type: application/octet-stream`,
    });
    assert.doesNotMatch(generated, /^\/docs\/\*\/index.md$/m);
  }
  const encodedOwner = agentDiscoveryHeaderRules(minimal, options, [], {
    paths: ["/café/index.md", "/my guide/index.md"],
    ownerHeaders:
      "/docs/caf%C3%A9/index.md\n  Content-Type: application/octet-stream",
  });
  assert.doesNotMatch(encodedOwner, /^\/docs\/\*\/index.md$/m);
});

test("text header patterns serialize Unicode and spaces in the base once", () => {
  for (const base of ["/café", "/caf%C3%A9", "/my docs", "/my%20docs"]) {
    const prefix = base.includes("caf") ? "/caf%C3%A9" : "/my%20docs";
    const generated = agentDiscoveryHeaderRules(
      createAgentCapabilities({}),
      { ...options, base },
      [],
      { paths: ["/llms.txt", "/guide/index.md"] },
    );
    assert.ok(
      generated.includes(
        `${prefix}/llms.txt\n  Content-Type: text/plain; charset=utf-8`,
      ),
    );
    assert.ok(
      generated.includes(
        `${prefix}/*/index.md\n  Content-Type: text/markdown; charset=utf-8`,
      ),
    );
  }
});

test("raw and encoded owner paths do not duplicate generated text Content-Type", () => {
  for (const [pathname, ownerPath] of [
    ["/café/index.md", "/docs/café/index.md"],
    ["/café/index.md", "/docs/caf%C3%A9/index.md"],
    ["/my guide/index.md", "/docs/my guide/index.md"],
    ["/my guide/index.md", "/docs/my%20guide/index.md"],
  ]) {
    const ownerHeaders = `${ownerPath}\n  Content-Type: application/octet-stream`;
    const generated = agentDiscoveryHeaderRules(minimal, options, [], {
      paths: [pathname!],
      ownerHeaders,
    });
    assert.doesNotMatch(generated, /^\/docs\/\*\/index.md$/m, ownerPath);
    assert.ok(
      appendAgentDiscoveryHeaders(ownerHeaders, generated).startsWith(
        ownerHeaders,
      ),
    );
  }
});

test("nested section indexes get the UTF-8 llms.txt header", () => {
  const generated = agentDiscoveryHeaderRules(minimal, options, [], {
    paths: ["/reference/functions/dates/llms.txt"],
  });
  assert.match(generated, /^\/docs\/\*\/llms\.txt\n  Content-Type: text\/plain; charset=utf-8$/m);
});

test("split llms-full.txt sections get the UTF-8 header, only when there are any", () => {
  const split = agentDiscoveryHeaderRules(minimal, options, [], {
    paths: ["/llms-full.txt", "/reference/llms-full.txt"],
  });
  assert.match(split, /^\/docs\/\*\/llms-full\.txt\n  Content-Type: text\/plain; charset=utf-8$/m);
  const whole = agentDiscoveryHeaderRules(minimal, options, [], { paths: ["/llms-full.txt"] });
  assert.doesNotMatch(whole, /\*\/llms-full\.txt/);
});

test("a site-wide owner rule that sets a header keeps generated rules from repeating it", () => {
  const skills = createAgentCapabilities({
    llmsUrl: minimal.llmsUrl,
    homepageMarkdownUrl: minimal.homepageMarkdownUrl,
    skillsIndexUrl: `${options.site}/.well-known/agent-skills/index.json`,
    apis: [
      {
        collection: "pets",
        docsUrl: `${options.site}/docs/pets/`,
        markdownUrl: `${options.site}/docs/pets/index.md`,
        spec: { url: `${options.site}/docs/pets/openapi.json`, type: "application/vnd.oai.openapi+json" },
      },
    ],
  });
  // The report: a site-wide CORS policy and an exact Content-Type for the skills index.
  const owner = [
    "/*",
    "  Access-Control-Allow-Origin: *",
    "  X-Frame-Options: DENY",
    "",
    "/.well-known/agent-skills/index.json",
    "  Content-Type: application/json; charset=utf-8",
    "",
  ].join("\n");
  const warnings: string[] = [];
  const generated = agentDiscoveryHeaderRules(skills, options, undefined, {
    paths: ["/llms.txt", "/index.md"],
    ownerHeaders: owner,
    warn: (message) => warnings.push(message),
  });
  assert.doesNotMatch(generated, /Access-Control-Allow-Origin/, "the owner's /* rule already sets it everywhere");
  assert.doesNotMatch(generated, /agent-skills\/index\.json/, "the owner's exact rule already types the index");
  assert.match(generated, /^\/\.well-known\/ard\.json\n  Content-Type: application\/json$/m, "its own header survives");
  assert.match(generated, /^\/\.well-known\/api-catalog\n  Content-Type: [^\n]+\n  Link: /m);
  assert.match(generated, /^\/docs\/pets\/openapi\.json\n  Content-Type: application\/vnd\.oai\.openapi\+json$/m);
  assert.match(generated, /^\/\.well-known\/agent-skills\/\*\.tar\.gz\n  Content-Type: application\/gzip$/m);
  assert.doesNotMatch(generated, /^\/\.well-known\/agent-skills\/\*\n/m, "a rule left with no headers is omitted");
  assert.deepEqual(warnings, []);
  const merged = appendAgentDiscoveryHeaders(owner, generated);
  const names = (header: string) => (merged.match(new RegExp(`^\\s+${header}:`, "gmi")) ?? []).length;
  assert.equal(names("Access-Control-Allow-Origin"), 1);
  assert.equal((merged.match(/^\/\.well-known\/agent-skills\/index\.json$/gm) ?? []).length, 1);
  assert.equal((merged.match(/^  Content-Type: application\/json$/gm) ?? []).length, 2, "ard.json and ai-catalog.json only");
  assert.ok(merged.startsWith(owner));
  assert.equal(appendAgentDiscoveryHeaders(merged, generated), merged, "regenerating is stable");
});

test("an owner rule narrower than a generated wildcard wins, with a warning, and ! removals count as policy", () => {
  const skills = createAgentCapabilities({
    llmsUrl: minimal.llmsUrl,
    skillsIndexUrl: `${options.site}/.well-known/agent-skills/index.json`,
  });
  const warnings: string[] = [];
  const narrower = agentDiscoveryHeaderRules(skills, options, [], {
    skillPaths: ["/.well-known/agent-skills/index.json", "/.well-known/agent-skills/deploy/SKILL.md"],
    ownerHeaders: "/.well-known/agent-skills/index.json\n  Access-Control-Allow-Origin: https://app.example.com\n",
    warn: (message) => warnings.push(message),
  });
  assert.doesNotMatch(narrower, /^\/\.well-known\/agent-skills\/\*\n  Access-Control-Allow-Origin/m);
  assert.match(narrower, /^\/\.well-known\/ard\.json\n  Content-Type: application\/json\n  Access-Control-Allow-Origin: \*$/m, "other paths keep theirs");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Access-Control-Allow-Origin rule \/\.well-known\/agent-skills\/index\.json overlaps \/\.well-known\/agent-skills\/\*/);
  const removal = agentDiscoveryHeaderRules(skills, options, [], {
    ownerHeaders: "/.well-known/*\n  ! Access-Control-Allow-Origin\n",
  });
  assert.doesNotMatch(removal, /Access-Control-Allow-Origin/);
  assert.match(removal, /Content-Type: application\/json/);
  // Hosts read the unset operator as `! ` with the space; `!Name` is invalid
  // there and is not a policy here either.
  const notAnUnset = agentDiscoveryHeaderRules(skills, options, [], {
    ownerHeaders: "/.well-known/*\n  !Access-Control-Allow-Origin\n",
  });
  assert.match(notAnUnset, /Access-Control-Allow-Origin: \*/);
  // Link may repeat: hosts join it with a comma, which is valid for Link.
  const linked = agentDiscoveryHeaderRules(minimal, options, [], {
    ownerHeaders: "/*\n  Link: <https://example.net/>; rel=help\n",
  });
  assert.match(linked, /^\/docs\/\n  Link: /m);
  // Header names match case-insensitively; a commented-out line is not a policy.
  const cased = agentDiscoveryHeaderRules(minimal, options, [], {
    ownerHeaders: "/*\n  access-control-allow-origin: *\n# /.well-known/ard.json\n#  Content-Type: text/plain\n",
  });
  assert.doesNotMatch(cased, /Access-Control-Allow-Origin/);
  assert.match(cased, /^\/\.well-known\/ard\.json\n  Content-Type: application\/json$/m);
});

test("owner wildcards that cover some skills files win for the family, with a warning; disjoint ones don't", () => {
  const skills = createAgentCapabilities({
    llmsUrl: minimal.llmsUrl,
    skillsIndexUrl: `${options.site}/.well-known/agent-skills/index.json`,
  });
  const skillPaths = [
    "/.well-known/agent-skills/index.json",
    "/.well-known/agent-skills/deploy/SKILL.md",
    "/.well-known/agent-skills/deploy.tar.gz",
  ];
  for (const pattern of ["/*.json", "/*/index.json", "https://docs.example.com/*.json", "/.well-known/agent-skills/deploy/*"]) {
    const warnings: string[] = [];
    const generated = agentDiscoveryHeaderRules(skills, options, [], {
      skillPaths,
      ownerHeaders: `${pattern}\n  Access-Control-Allow-Origin: *\n`,
      warn: (message) => warnings.push(message),
    });
    assert.doesNotMatch(generated, /^\/\.well-known\/agent-skills\/\*\n  Access-Control-Allow-Origin/m, pattern);
    assert.match(generated, /^\/\.well-known\/agent-skills\/\*\.tar\.gz\n  Content-Type: application\/gzip$/m, pattern);
    assert.ok(warnings.some((message) => message.includes(pattern) && message.includes("/.well-known/agent-skills/*")), pattern);
    // The exact discovery files are covered only by a pattern that matches them.
    const ardKeepsCors = /^\/\.well-known\/ard\.json\n[^\n]*\n  Access-Control-Allow-Origin/m.test(generated);
    assert.equal(ardKeepsCors, !pattern.endsWith("*.json"), pattern);
  }
  // An owner rule covering every skills file drops the header silently.
  const all: string[] = [];
  const whole = agentDiscoveryHeaderRules(skills, options, [], {
    skillPaths,
    ownerHeaders: "/.well-known/agent-skills/*\n  Access-Control-Allow-Origin: https://app.example.com\n",
    warn: (message) => all.push(message),
  });
  assert.doesNotMatch(whole, /^\/\.well-known\/agent-skills\/\*\n  Access-Control-Allow-Origin/m);
  assert.deepEqual(all, []);
  // Disjoint wildcards leave the generated rule alone: fonts, an asset folder,
  // and a `:param` that spans one segment and never reaches the skills index.
  const disjoint = agentDiscoveryHeaderRules(skills, options, [], {
    skillPaths,
    ownerHeaders: "/assets/*\n  Access-Control-Allow-Origin: *\n/*.woff2\n  Access-Control-Allow-Origin: *\n/:dir/index.json\n  Access-Control-Allow-Origin: *\n",
  });
  assert.match(disjoint, /^\/\.well-known\/agent-skills\/\*\n  Access-Control-Allow-Origin: \*$/m);
  // Without the artifact list, the index is still a known member.
  const indexOnly = agentDiscoveryHeaderRules(skills, options, [], {
    ownerHeaders: "/*.json\n  Access-Control-Allow-Origin: *\n",
  });
  assert.doesNotMatch(indexOnly, /^\/\.well-known\/agent-skills\/\*\n  Access-Control-Allow-Origin/m);
});

test("owner files are read the way hosts read them: trimmed lines, paths by shape, a leading BOM ignored", () => {
  const skills = createAgentCapabilities({
    llmsUrl: minimal.llmsUrl,
    skillsIndexUrl: `${options.site}/.well-known/agent-skills/index.json`,
  });
  // An unindented header line still belongs to the rule above it.
  const unindented = agentDiscoveryHeaderRules(skills, options, [], {
    ownerHeaders: "/*\nAccess-Control-Allow-Origin: *\n",
  });
  assert.doesNotMatch(unindented, /Access-Control-Allow-Origin/);
  // An indented path line starts a rule; its header is not credited to /*.
  const indentedPath = agentDiscoveryHeaderRules(skills, options, [], {
    ownerHeaders: "/*\n  X-Frame-Options: DENY\n  /.well-known/ard.json\n  Access-Control-Allow-Origin: *\n",
  });
  assert.doesNotMatch(indentedPath, /^\/\.well-known\/ard\.json\n[^\n]*\n  Access-Control-Allow-Origin/m);
  assert.match(indentedPath, /^\/\.well-known\/ai-catalog\.json\n  Content-Type: application\/json\n  Access-Control-Allow-Origin: \*$/m);
  assert.match(indentedPath, /^\/\.well-known\/agent-skills\/\*\n  Access-Control-Allow-Origin: \*$/m);
  // A BOM before the first path.
  const bom = agentDiscoveryHeaderRules(skills, options, [], {
    ownerHeaders: "\uFEFF/*\n  Access-Control-Allow-Origin: *\n",
  });
  assert.doesNotMatch(bom, /Access-Control-Allow-Origin/);
  // The splice step reads path lines the same way.
  const owner = "\uFEFF  /.well-known/ard.json\n  X-Robots-Tag: none\n";
  const generated = agentDiscoveryHeaderRules(skills, options, [], { ownerHeaders: owner });
  const merged = appendAgentDiscoveryHeaders(owner, generated);
  assert.equal((merged.match(/^\s*\/\.well-known\/ard\.json$/gm) ?? []).length, 1, "merged into the owner's block");
  assert.match(merged, /X-Robots-Tag: none\n# Nimbus agent discovery headers \(generated\)\n  Content-Type: application\/json\n  Access-Control-Allow-Origin: \*\n# End/);
  assert.equal(appendAgentDiscoveryHeaders(merged, generated), merged);
});

test("an owner rule for a page that isn't emitted doesn't drop a text family that is", () => {
  const warnings: string[] = [];
  const generated = agentDiscoveryHeaderRules(minimal, options, [], {
    paths: ["/other/index.md"],
    ownerHeaders: "/docs/guide/index.md\n  Content-Type: text/markdown\n",
    warn: (message) => warnings.push(message),
  });
  assert.match(generated, /^\/docs\/\*\/index\.md\n  Content-Type: text\/markdown; charset=utf-8$/m);
  assert.deepEqual(warnings, []);
});

test("owner rules the host rejects are no policy, a blank value is ignored, and ! Link is honoured", () => {
  const skills = createAgentCapabilities({
    llmsUrl: minimal.llmsUrl,
    skillsIndexUrl: `${options.site}/.well-known/agent-skills/index.json`,
  });
  const corsEverywhere = /^\/\.well-known\/ard\.json\n  Content-Type: application\/json\n  Access-Control-Allow-Origin: \*$/m;
  for (const rejected of [
    "http://docs.example.com/*",
    "https://docs.example.com:8443/*",
    "wss://docs.example.com/*",
    "/*/*.json",
    "/*/:splat",
  ]) {
    const generated = agentDiscoveryHeaderRules(skills, options, [], {
      ownerHeaders: `${rejected}\n  Access-Control-Allow-Origin: *\n`,
    });
    assert.match(generated, corsEverywhere, rejected);
    assert.match(generated, /^\/\.well-known\/agent-skills\/\*\n  Access-Control-Allow-Origin: \*$/m, rejected);
  }
  const accepted = agentDiscoveryHeaderRules(skills, options, [], {
    ownerHeaders: "https://docs.example.com/*\n  Access-Control-Allow-Origin: *\n",
  });
  assert.doesNotMatch(accepted, /Access-Control-Allow-Origin/);
  const blank = agentDiscoveryHeaderRules(skills, options, [], {
    ownerHeaders: "/*\n  Access-Control-Allow-Origin:\n  Access-Control-Allow-Origin:   \n",
  });
  assert.match(blank, corsEverywhere);
  const unsetLink = agentDiscoveryHeaderRules(minimal, options, [], {
    ownerHeaders: "/*\n  ! Link\n",
  });
  assert.doesNotMatch(unsetLink, /Link:/);
  assert.match(unsetLink, /^\/\.well-known\/ard\.json\n  Content-Type/m, "other headers stay");
});

test("an owner line that normalizes to a generated path is the same rule, and extra slashes after https: are read like the host does", () => {
  const owner = "/.well-known/ard.json?x=1\n  Access-Control-Allow-Origin: https://app.example.com\n  X-Robots-Tag: none\n";
  const generated = agentDiscoveryHeaderRules(minimal, options, [], { ownerHeaders: owner });
  assert.doesNotMatch(generated, /^\/\.well-known\/ard\.json\n[^\n]*\n  Access-Control-Allow-Origin/m);
  const merged = appendAgentDiscoveryHeaders(owner, generated);
  assert.equal((merged.match(/^\s*\/\.well-known\/ard\.json(\?x=1)?$/gm) ?? []).length, 1, "spliced into the owner's rule, not a second rule for the same key");
  assert.match(merged, /X-Robots-Tag: none\n# Nimbus agent discovery headers \(generated\)\n  Content-Type: application\/json\n# End/);
  assert.equal(appendAgentDiscoveryHeaders(merged, generated), merged);
  const spaced = "/pets api/openapi.json\n  Access-Control-Allow-Origin: https://app.example.com\n";
  const specs = [{ pathname: "/pets%20api/openapi.json", type: "application/vnd.oai.openapi+json" }];
  const spacedMerged = appendAgentDiscoveryHeaders(spaced, agentDiscoveryHeaderRules(minimal, options, specs, { ownerHeaders: spaced }));
  assert.equal((spacedMerged.match(/^\s*\/pets(%20| )api\/openapi\.json$/gm) ?? []).length, 1);
  assert.match(spacedMerged, /\/pets api\/openapi\.json\n  Access-Control-Allow-Origin: https:\/\/app\.example\.com\n# Nimbus agent discovery headers \(generated\)\n  Content-Type: application\/vnd/);
  const skills = createAgentCapabilities({ llmsUrl: minimal.llmsUrl, skillsIndexUrl: `${options.site}/.well-known/agent-skills/index.json` });
  for (const pattern of ["https:///docs.example.com/*", "https://docs.example.com//.well-known/*"]) {
    const slashes = agentDiscoveryHeaderRules(skills, options, [], {
      ownerHeaders: `${pattern}\n  Access-Control-Allow-Origin: *\n`,
    });
    assert.doesNotMatch(slashes, /^\/\.well-known\/ard\.json\n[^\n]*\n  Access-Control-Allow-Origin/m, pattern);
  }
  // A later owner rule for the same path replaces an earlier one, as on the host.
  const replaced = agentDiscoveryHeaderRules(minimal, options, [], {
    ownerHeaders: "/.well-known/ard.json\n  Content-Type: application/json\n/.well-known/ard.json?x=1\n  X-Other: 1\n",
  });
  assert.match(replaced, /^\/\.well-known\/ard\.json\n  Content-Type: application\/json/m, "the surviving rule sets no Content-Type, so the generated one stays");
});

test("a remote MCP server is one catalog entry pointing at its card, which serves its own headers", () => {
  const capabilities = createAgentCapabilities({
    llmsUrl: minimal.llmsUrl,
    homepageMarkdownUrl: minimal.homepageMarkdownUrl,
    mcpUrl: `${options.site}/docs/mcp`,
  });
  const document = agentDiscoveryManifest(capabilities, options);
  for (const validate of [validateArd, validateCatalog])
    assert.equal(validate(document), true, JSON.stringify(validate.errors));
  const entry = document.entries.find((item) => item.type === "application/mcp-server-card+json");
  assert.deepEqual(entry, {
    identifier: "urn:air:docs.example.com:docs-docs:mcp",
    displayName: "Example MCP server",
    type: "application/mcp-server-card+json",
    url: "https://docs.example.com/docs/mcp/server-card",
    representativeQueries: [
      "Read the Example documentation over MCP",
      "List the pages of the Example documentation",
    ],
  });
  assert.doesNotMatch(agentDiscoveryHeaderRules(capabilities, options), /server-card/);
  assert.doesNotMatch(JSON.stringify(agentDiscoveryManifest(minimal, options)), /mcp/);
});
