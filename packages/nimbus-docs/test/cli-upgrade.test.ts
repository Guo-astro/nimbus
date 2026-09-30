// The pure classification cores behind `outdated` / `diff`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { STARTER_MANIFEST } from "../../nimbus-starter-source/starter.manifest.mjs";
import {
  classifyStarter,
  diffCommand,
  gatherOutdated,
  STARTER_ROOT_FILES,
  type TemplateSource,
  labelWithVersions,
  registryDrift,
  selectStarterApplyTarget,
} from "../src/cli/upgrade.js";
import { bytesHash, readNimbusJson } from "../src/cli/nimbus-json.js";
import type { NimbusJson } from "../src/cli/nimbus-json.js";
import type { ComponentItem, RegistryFile } from "../src/cli/resolver.js";

function item(name: string, files: RegistryFile[]): ComponentItem {
  return { name, type: "registry:ui", title: name, description: "t", dependencies: [], registryDependencies: [], files };
}

test("classifyStarter buckets clean / hand-merge / deleted / local, skips unchanged", () => {
  const base: Record<string, string> = {
    "src/components/ui/a/A.astro": "A1",
    "src/components/ui/b/B.astro": "B1",
    "src/layouts/L.astro": "L1",
    "src/content/docs/x.mdx": "X1",
    "src/components/ui/same/S.astro": "S1",
    "src/components/ui/applied/P.astro": "P1",
  };
  const upstream: Record<string, string> = {
    "src/components/ui/a/A.astro": "A2", // changed upstream
    "src/components/ui/b/B.astro": "B2", // changed upstream
    "src/layouts/L.astro": "L2", // changed upstream
    "src/content/docs/x.mdx": "X1", // unchanged upstream
    "src/components/ui/same/S.astro": "S1", // unchanged upstream
    "src/components/ui/applied/P.astro": "P2", // changed upstream
  };
  const disk: Record<string, string | null> = {
    "src/components/ui/a/A.astro": "A1", // == base → clean
    "src/components/ui/b/B.astro": "Bedited", // != base → hand-merge
    "src/layouts/L.astro": null, // removed → deleted
    "src/content/docs/x.mdx": "Xedited", // != base, upstream unchanged → local
    "src/components/ui/same/S.astro": "S1", // unchanged everywhere → skip
    "src/components/ui/applied/P.astro": "P2", // == upstream (you ran --apply) → resolved, skip
  };

  const findings = classifyStarter({
    srcRoot: "src",
    baseFiles: Object.keys(base),
    readBase: (t) => base[t] ?? null,
    readUpstream: (t) => upstream[t] ?? null,
    readDisk: (file) => disk[file] ?? null,
  });

  const by = Object.fromEntries(findings.map((f) => [f.treeFile, f]));
  assert.equal(by["src/components/ui/a/A.astro"]!.status, "clean");
  assert.equal(by["src/components/ui/a/A.astro"]!.surface, "components");
  assert.equal(by["src/components/ui/a/A.astro"]!.file, "src/components/ui/a/A.astro");
  assert.equal(by["src/components/ui/b/B.astro"]!.status, "hand-merge");
  assert.equal(by["src/layouts/L.astro"]!.status, "deleted");
  assert.equal(by["src/layouts/L.astro"]!.surface, "layouts");
  assert.equal(by["src/content/docs/x.mdx"]!.status, "local");
  assert.equal(by["src/content/docs/x.mdx"]!.surface, "content");
  assert.equal(by["src/components/ui/same/S.astro"], undefined); // unchanged → not reported
  assert.equal(by["src/components/ui/applied/P.astro"], undefined); // disk == upstream (applied) → resolved, not reported
});

test("classifyStarter display path honors a monorepo srcRoot", () => {
  const findings = classifyStarter({
    srcRoot: "packages/docs/src",
    baseFiles: ["src/components/ui/a/A.astro"],
    readBase: () => "A1",
    readUpstream: () => "A2",
    readDisk: () => "A1",
  });
  assert.equal(findings[0]!.file, "packages/docs/src/components/ui/a/A.astro");
});

test("starter apply rejects an ambiguous suffix", () => {
  const finding = (file: string) => ({
    file,
    treeFile: file,
    surface: "components",
    status: "clean" as const,
  });
  assert.throws(
    () =>
      selectStarterApplyTarget("Button.astro", [
        finding("src/one/Button.astro"),
        finding("src/two/Button.astro"),
      ]),
    /matches multiple starter files/,
  );
  assert.equal(
    selectStarterApplyTarget("src/one/Button.astro", [
      finding("src/one/Button.astro"),
    ])?.file,
    "src/one/Button.astro",
  );
});

test("classifyStarter discovers safe upstream additions and removals", () => {
  const base = { "src/old.ts": "old", "src/changed.ts": "before" };
  const upstream = { "src/new.ts": "new", "src/changed.ts": "after" };
  const disk: Record<string, string | null> = {
    "src/old.ts": "old",
    "src/new.ts": null,
    "src/changed.ts": "before",
  };
  const findings = classifyStarter({
    srcRoot: "src",
    baseFiles: Object.keys(base),
    upstreamFiles: Object.keys(upstream),
    readBase: (file) => base[file as keyof typeof base] ?? null,
    readUpstream: (file) => upstream[file as keyof typeof upstream] ?? null,
    readDisk: (file) => disk[file] ?? null,
  });
  const statuses = Object.fromEntries(findings.map((finding) => [finding.treeFile, finding.status]));
  assert.deepEqual(statuses, {
    "src/changed.ts": "clean",
    "src/new.ts": "added",
    "src/old.ts": "removed",
  });
});

test("registryDrift reports version drift (from → to) and labels it", async () => {
  const current = { ...item("dialog", [{ path: "components/ui/dialog/Dialog.astro", content: "NEW" }]), version: "0.9.0" };
  const nimbus: NimbusJson = {
    components: [
      { slug: "dialog", type: "registry:ui", version: "0.7.0", source: "s", hash: "sha256:old", files: [] },
    ],
  };
  const [f] = await registryDrift(nimbus, async () => current);
  assert.equal(f!.status, "behind");
  assert.equal(f!.from, "0.7.0");
  assert.equal(f!.to, "0.9.0");
  assert.equal(labelWithVersions(f!), "dialog (0.7.0 → 0.9.0)");
  // No version info → bare slug.
  assert.equal(labelWithVersions({ slug: "cn", status: "behind" }), "cn");
});

test("registryDrift flags behind, marks unverified, skips current + hand-authored", async () => {
  const dialog = item("dialog", [{ path: "components/ui/dialog/Dialog.astro", content: "D" }]);
  const card = item("card", [{ path: "components/ui/card/Card.astro", content: "NEW" }]);

  const nimbus: NimbusJson = {
    components: [
      { slug: "dialog", type: "registry:ui", source: "s", hash: bytesHash(dialog.files), files: [] }, // current
      { slug: "card", type: "registry:ui", source: "s", hash: "sha256:stale", files: [] }, // behind
      { slug: "mine", type: "registry:ui", source: null, hash: null, files: [], handAuthored: true }, // skip
      { slug: "off", type: "registry:ui", source: "s", hash: "sha256:x", files: [] }, // unverified
    ],
  };

  const fetchItem = async (slug: string): Promise<ComponentItem | null> =>
    slug === "dialog" ? dialog : slug === "card" ? card : null;

  const findings = await registryDrift(nimbus, fetchItem);
  const by = Object.fromEntries(findings.map((f) => [f.slug, f.status]));
  assert.equal(by.card, "behind");
  assert.equal(by.off, "unverified");
  assert.equal(by.dialog, undefined); // current → not reported
  assert.equal(by.mine, undefined); // hand-authored → skipped
});

test("outdated warns when the compared starter needs a newer package", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-outdated-compat-"));
  try {
    const project = path.join(root, "site");
    const template = path.join(root, "template");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.mkdirSync(path.join(project, "node_modules", "@cloudflare", "nimbus-docs"), { recursive: true });
    fs.mkdirSync(path.join(template, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    fs.writeFileSync(
      path.join(project, "nimbus.json"),
      JSON.stringify({ templatesTag: "templates-v0.7.7", variant: "template", install: { root: "src" }, components: [] }),
    );
    const install = (version: string) =>
      fs.writeFileSync(
        path.join(project, "node_modules", "@cloudflare", "nimbus-docs", "package.json"),
        JSON.stringify({ name: "@cloudflare/nimbus-docs", version }),
      );
    fs.writeFileSync(
      path.join(template, "package.json"),
      JSON.stringify({ dependencies: { "@cloudflare/nimbus-docs": "^0.15.0" } }),
    );
    const warnings = async () =>
      (await gatherOutdated(project, { templateDir: template, json: true })).warnings;

    install("0.15.3");
    assert.deepEqual(await warnings(), []);
    install("0.15.1-pr.170.sha0123abc");
    assert.deepEqual(await warnings(), []);

    install("0.14.2");
    const newer = await warnings();
    assert.equal(newer[0]?.code, "starter-needs-newer-package");
    assert.match(newer[0]?.message ?? "", /targets @cloudflare\/nimbus-docs \^0\.15\.0, but the project has 0\.14\.2/);

    install("0.16.0");
    assert.deepEqual(await warnings(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI tracks the root files the starter manifest declares", () => {
  assert.deepEqual([...STARTER_ROOT_FILES].sort(), [...STARTER_MANIFEST.trackedRootFiles].sort());
});

// End to end over three fixture tags: the site was scaffolded from v1, and
// upstream moves on to v2, then v3.
function starterFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-starter-e2e-"));
  const trees: Record<string, Record<string, string>> = {
    "templates-v0.1.0": {
      "AGENT.md": "# Agents\nold guidance\n",
      "package.json": '{ "name": "starter" }\n',
      "tsconfig.json": "{}\n",
      "src/pages/index.astro": "<h1>one</h1>\n",
    },
    "templates-v0.2.0": {
      "AGENT.md": "# Agents\nnew guidance\n",
      "package.json": '{ "name": "starter", "private": true }\n',
      "tsconfig.json": "{}\n",
      "src/pages/index.astro": "<h1>two</h1>\n",
    },
    "templates-v0.3.0": {
      "AGENT.md": "# Agents\nnew guidance\n",
      "package.json": '{ "name": "starter", "private": true }\n',
      "tsconfig.json": "{}\n",
      "src/pages/index.astro": "<h1>three</h1>\n",
    },
  };
  const write = (dir: string, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
  };
  for (const [tag, files] of Object.entries(trees)) write(path.join(root, tag), files);
  const project = path.join(root, "site");
  write(project, {
    ...trees["templates-v0.1.0"],
    // The scaffolder rewrites package.json on every site.
    "package.json": '{ "name": "my-docs", "dependencies": {} }\n',
    "nimbus.json": JSON.stringify({ templatesTag: "templates-v0.1.0", variant: "starter", components: [] }),
  });
  let latest = "templates-v0.2.0";
  const source: TemplateSource = {
    resolve: async (tag) => ({ dir: path.join(root, tag), cleanup: () => {} }),
    latestTag: async () => latest,
  };
  return {
    project,
    source,
    release: (tag: string) => {
      latest = tag;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function runDiff(
  file: string | undefined,
  flags: Parameters<typeof diffCommand>[1],
  options: Parameters<typeof diffCommand>[2],
): Promise<{ stdout: string; exitCode: number }> {
  const write = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
  try {
    await diffCommand(file, { color: false, ...flags }, options);
  } finally {
    process.stdout.write = write;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout, exitCode };
}

test("diff reports upstream changes to tracked root files, never package.json", async () => {
  const fixture = starterFixture();
  try {
    const { project, source } = fixture;
    const outdated = await gatherOutdated(project, { json: true }, source);
    const starter = Object.fromEntries(outdated.starter.map((item) => [item.file, item.status]));
    assert.equal(starter["AGENT.md"], "clean");
    assert.equal(starter["src/pages/index.astro"], "clean");
    assert.equal(starter["package.json"], undefined);
    assert.equal(starter["tsconfig.json"], undefined);

    const agent = await runDiff("AGENT.md", {}, { cwd: project, source });
    assert.equal(agent.exitCode, 0);
    assert.match(agent.stdout, /upstream \(clean to pull\) · AGENT\.md/);
    assert.match(agent.stdout, /\+new guidance/);

    const pkg = await runDiff("package.json", {}, { cwd: project, source });
    assert.equal(pkg.exitCode, 1);
  } finally {
    fixture.cleanup();
  }
});

test("a file taken with diff --apply stays clean through the next upstream change", async () => {
  const fixture = starterFixture();
  try {
    const { project, source } = fixture;
    const applied = await runDiff("src/pages/index.astro", { apply: true }, { cwd: project, source });
    assert.equal(applied.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(project, "src/pages/index.astro"), "utf8"), "<h1>two</h1>\n");
    const record = readNimbusJson(project);
    assert.equal(record?.templatesTag, "templates-v0.1.0");
    assert.deepEqual(record?.templatesTagByFile, { "src/pages/index.astro": "templates-v0.2.0" });

    assert.equal((await runDiff("AGENT.md", { apply: true }, { cwd: project, source })).exitCode, 0);
    assert.equal(fs.readFileSync(path.join(project, "AGENT.md"), "utf8"), "# Agents\nnew guidance\n");

    // Upstream changes the page again; the site has no local edits against v2.
    fixture.release("templates-v0.3.0");
    const outdated = await gatherOutdated(project, { json: true }, source);
    const starter = Object.fromEntries(outdated.starter.map((item) => [item.file, item.status]));
    assert.deepEqual(starter, { "src/pages/index.astro": "clean" });

    assert.equal((await runDiff("src/pages/index.astro", { apply: true }, { cwd: project, source })).exitCode, 0);
    assert.equal(fs.readFileSync(path.join(project, "src/pages/index.astro"), "utf8"), "<h1>three</h1>\n");
    assert.deepEqual(readNimbusJson(project)?.templatesTagByFile, {
      "AGENT.md": "templates-v0.2.0",
      "src/pages/index.astro": "templates-v0.3.0",
    });

    // A local edit on top of the applied version is still the site's own.
    fs.writeFileSync(path.join(project, "src/pages/index.astro"), "<h1>mine</h1>\n");
    const local = await gatherOutdated(project, { json: true }, source);
    assert.deepEqual(local.starter.map((item) => [item.file, item.status]), [["src/pages/index.astro", "local"]]);
  } finally {
    fixture.cleanup();
  }
});

test("--to is ignored with --template-dir, so a typo is never fetched or recorded", async () => {
  const fixture = starterFixture();
  try {
    const { project, source } = fixture;
    const strict: TemplateSource = {
      resolve: async (tag) => {
        if (tag === "templates-v0-typo") throw new Error(`no ${tag}`);
        return source.resolve(tag);
      },
      latestTag: source.latestTag,
    };
    const outdated = await gatherOutdated(project, { json: true, templateDir: "unused", to: "templates-v0-typo" }, strict);
    assert.deepEqual(outdated.errors.filter((error) => error.scope === "starter"), []);
    await runDiff("AGENT.md", { apply: true, templateDir: "unused", to: "templates-v0-typo" }, { cwd: project, source: strict });
    assert.equal(readNimbusJson(project)?.templatesTagByFile, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("an applied tag is written beside templatesTag", async () => {
  const fixture = starterFixture();
  try {
    const { project, source } = fixture;
    await runDiff("src/pages/index.astro", { apply: true }, { cwd: project, source });
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(project, "nimbus.json"), "utf8")));
    assert.equal(keys[keys.indexOf("templatesTag") + 1], "templatesTagByFile");
  } finally {
    fixture.cleanup();
  }
});

test("a file upstream added that the site already has is labelled as such", async () => {
  const fixture = starterFixture();
  try {
    const { project, source } = fixture;
    fs.writeFileSync(path.join((await source.resolve("templates-v0.2.0")).dir, "CLAUDE.md"), "See AGENT.md.\n");
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "My own notes.\n");
    const shown = await runDiff("CLAUDE.md", {}, { cwd: project, source });
    assert.match(shown.stdout, /upstream added a file you already have — hand-merge · CLAUDE\.md/);
    assert.doesNotMatch(shown.stdout, /diverge from the recorded tag/);
  } finally {
    fixture.cleanup();
  }
});
