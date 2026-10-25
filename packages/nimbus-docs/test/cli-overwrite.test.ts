// `add --overwrite` is the upgrade verb. Without it, `--yes` never clobbers
// owned files; with it, edited files are asked about in a terminal, kept when
// nobody can be asked, and replaced only under `--yes`. Tests run with no TTY.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { installComponents, keptLines, localEdits, registerHint, starterBaseline, type InstallOptions, type KeptComponent, type Prompts } from "../src/cli/component.js";
import { bytesHash, fileHash } from "../src/cli/nimbus-json.js";
import type { ComponentItem, RegistryFile } from "../src/cli/resolver.js";

function item(
  name: string,
  type: "registry:ui" | "registry:lib",
  files: RegistryFile[],
): ComponentItem {
  return { name, type, title: name, description: "t", dependencies: [], registryDependencies: [], files };
}

async function withProject(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "nimbus-ow-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const opts = (cwd: string, over: Partial<InstallOptions> = {}): InstallOptions => ({
  cwd,
  yes: false,
  overwrite: false,
  ...over,
});

const dialog = (content: string) =>
  item("dialog", "registry:ui", [{ path: "components/ui/dialog/Dialog.astro", content }]);
const cn = (content: string) => item("cn", "registry:lib", [{ path: "lib/cn.ts", content }]);
// A record as `add` writes it, and one written before per-file hashes.
const recordFor = (slug: string, files: RegistryFile[]) =>
  new Map([
    [
      slug,
      {
        slug,
        hash: bytesHash(files),
        files: files.map((f) => `src/${f.path}`),
        fileHashes: Object.fromEntries(files.map((f) => [`src/${f.path}`, fileHash(f.content)])),
      },
    ],
  ]);
const oldRecordFor = (slug: string, files: RegistryFile[]) =>
  new Map([[slug, { slug, hash: bytesHash(files), files: files.map((f) => `src/${f.path}`) }]]);

test("a conflict without --overwrite keeps the existing file (non-interactive)", async () => {
  await withProject(async (cwd) => {
    const target = path.join(cwd, "src/components/ui/dialog/Dialog.astro");
    await installComponents([dialog("V1")], opts(cwd));

    const report = await installComponents([dialog("V2")], opts(cwd));
    assert.equal(readFileSync(target, "utf8"), "V1"); // untouched
    assert.deepEqual(report.skipped, ["dialog"]);
    assert.deepEqual(report.written, []);
  });
});

test("--overwrite replaces the existing file", async () => {
  await withProject(async (cwd) => {
    const target = path.join(cwd, "src/components/ui/dialog/Dialog.astro");
    await installComponents([dialog("V1")], opts(cwd));

    // The install record shows the file is untouched, so no question is needed.
    const recorded = recordFor("dialog", dialog("V1").files);
    const report = await installComponents([dialog("V2")], opts(cwd, { overwrite: true, recorded }));
    assert.equal(readFileSync(target, "utf8"), "V2");
    assert.deepEqual(report.written, ["src/components/ui/dialog/Dialog.astro"]);
    assert.deepEqual(report.skipped, []);
  });
});

test("--yes assents to prompts but never clobbers owned files", async () => {
  await withProject(async (cwd) => {
    const target = path.join(cwd, "src/components/ui/dialog/Dialog.astro");
    await installComponents([dialog("V1")], opts(cwd));

    const report = await installComponents([dialog("V2")], opts(cwd, { yes: true }));
    assert.equal(readFileSync(target, "utf8"), "V1"); // kept — --yes is not --overwrite
    assert.deepEqual(report.skipped, ["dialog"]);
  });
});

test("a lib conflict is kept without --overwrite, replaced with it", async () => {
  await withProject(async (cwd) => {
    const target = path.join(cwd, "src/lib/cn.ts");
    await installComponents([cn("V1")], opts(cwd));

    const kept = await installComponents([cn("V2")], opts(cwd));
    assert.equal(readFileSync(target, "utf8"), "V1");
    assert.deepEqual(kept.skipped, ["cn"]);

    const replaced = await installComponents([cn("V2")], opts(cwd, { overwrite: true, recorded: recordFor("cn", cn("V1").files) }));
    assert.equal(readFileSync(target, "utf8"), "V2");
    assert.deepEqual(replaced.written, ["src/lib/cn.ts"]);
  });
});

test("a fresh install writes regardless of flags (no conflict)", async () => {
  await withProject(async (cwd) => {
    const report = await installComponents([dialog("V1")], opts(cwd));
    assert.deepEqual(report.written, ["src/components/ui/dialog/Dialog.astro"]);
    assert.deepEqual(report.skipped, []);
  });
});

test("reinstalling identical files writes nothing and reports the item as up to date", async () => {
  await withProject(async (cwd) => {
    await installComponents([dialog("V1"), cn("C1")], opts(cwd));
    for (const overwrite of [false, true]) {
      const report = await installComponents([dialog("V1"), cn("C1")], opts(cwd, { overwrite }));
      assert.deepEqual(report.upToDate, ["dialog", "cn"]);
      assert.deepEqual([report.written, report.replaced, report.skipped], [[], [], []]);
    }
  });
});

test("--overwrite names each replaced file and leaves identical ones alone", async () => {
  await withProject(async (cwd) => {
    const files = (b: string) => [
      { path: "components/ui/dialog/Dialog.astro", content: "D1" },
      { path: "components/ui/dialog/DialogContent.astro", content: b },
    ];
    await installComponents([item("dialog", "registry:ui", files("C1"))], opts(cwd));
    const recorded = recordFor("dialog", files("C1"));
    const report = await installComponents([item("dialog", "registry:ui", files("C2"))], opts(cwd, { overwrite: true, recorded }));
    assert.deepEqual(report.replaced, [path.join("src", "components/ui/dialog/DialogContent.astro")]);
    assert.deepEqual(report.written, report.replaced);
  });
});

test("a kept component still gets its missing files", async () => {
  await withProject(async (cwd) => {
    const files = (b: string) => [
      { path: "components/ui/dialog/Dialog.astro", content: b },
      { path: "components/ui/dialog/DialogTitle.astro", content: "T1" },
    ];
    await installComponents([item("dialog", "registry:ui", [files("D1")[0]!])], opts(cwd));
    // Dialog.astro differs and is kept; DialogTitle.astro is new and written.
    const report = await installComponents([item("dialog", "registry:ui", files("D2"))], opts(cwd));
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "D1");
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/DialogTitle.astro"), "utf8"), "T1");
    assert.deepEqual(report.skipped, ["dialog"]);
    assert.deepEqual(report.kept, [path.join("src", "components/ui/dialog/Dialog.astro")]);
    assert.deepEqual(report.written, [path.join("src", "components/ui/dialog/DialogTitle.astro")]);
    assert.deepEqual(report.replaced, []);
  });
});

test("local edits compare the installed files, not the registry's current list", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "nimbus-edits-"));
  try {
    const installed = [{ path: "components/ui/x/X.astro", content: "<x />\n" }];
    const write = (rel: string, content: string) => {
      mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      writeFileSync(path.join(cwd, rel), content);
    };
    write("src/components/ui/x/X.astro", "<x />\n");
    const record = { hash: bytesHash(installed), files: ["src/components/ui/x/X.astro"] };
    // Upstream since added a file; the installed one is untouched.
    assert.equal(await localEdits(record, cwd, "src"), "none");
    write("src/components/ui/x/X.astro", "<x edited />\n");
    assert.equal(await localEdits(record, cwd, "src"), "edited");
    assert.equal(await localEdits(undefined, cwd, "src"), "unknown");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

test("a component without an install record is judged against the starter release", async () => {
  await withProject(async (root) => {
    const tree = path.join(root, "tree");
    const cwd = path.join(root, "site");
    writeFiles(tree, { "package.json": "{}", "src/components/ui/tabs/Tabs.astro": "<tabs />\n" });
    writeFiles(cwd, { "src/components/ui/tabs/Tabs.astro": "<tabs />\n", "src/components/ui/tabs/Extra.astro": "x" });
    const nimbus = { templatesTag: "templates-v1.0.0" };
    const tabs = "src/components/ui/tabs/Tabs.astro";
    const extra = "src/components/ui/tabs/Extra.astro";
    const edits = (files: string[], n: object | null = nimbus) =>
      localEdits(undefined, cwd, "src", { files, baseline: starterBaseline(n, "src", tree) });

    // A file the starter never shipped doesn't count either way.
    assert.equal(await edits([tabs, extra]), "none");
    assert.equal(await edits([extra]), "unknown");
    // No recorded tag (adopted, or a preview build), or the release can't be fetched.
    assert.equal(await edits([tabs], { templatesTag: null }), "unknown");
    const offline = starterBaseline(nimbus, "src", undefined, () => Promise.reject(new Error("offline")));
    assert.equal(await localEdits(undefined, cwd, "src", { files: [tabs], baseline: offline }), "unknown");
    assert.equal(offline?.error?.message, "offline", "a failed fetch is remembered so the report can name it");

    const local = starterBaseline(nimbus, "src", tree);
    await localEdits(undefined, cwd, "src", { files: [tabs], baseline: local });
    assert.equal(local?.error, null);

    writeFiles(cwd, { [tabs]: "<tabs edited />\n" });
    assert.equal(await edits([tabs]), "edited");
    // An install record still wins.
    const record = { hash: bytesHash([{ path: "components/ui/tabs/Tabs.astro", content: "<tabs edited />\n" }]), files: [tabs] };
    assert.equal(await localEdits(record, cwd, "src", { files: [tabs], baseline: starterBaseline(nimbus, "src", tree) }), "none");
  });
});

test("a file taken with diff --apply is judged against its own tag, each tag fetched once", async () => {
  await withProject(async (root) => {
    const cwd = path.join(root, "site");
    const tabs = "src/components/ui/tabs/Tabs.astro";
    const aside = "src/components/ui/aside/Aside.astro";
    for (const [tag, version] of [["templates-v1.0.0", "1"], ["templates-v1.1.0", "2"]] as const) {
      writeFiles(path.join(root, tag), { [tabs]: `tabs ${version}`, [aside]: `aside ${version}` });
    }
    writeFiles(cwd, { [tabs]: "tabs 2", [aside]: "aside 1" });
    const fetched: string[] = [];
    const baseline = starterBaseline(
      { templatesTag: "templates-v1.0.0", templatesTagByFile: { [tabs]: "templates-v1.1.0" } },
      "src",
      undefined,
      async (tag) => (fetched.push(tag), { dir: path.join(root, tag), cleanup: () => {} }),
    );
    assert.equal(await localEdits(undefined, cwd, "src", { files: [tabs, aside], baseline }), "none");
    assert.equal(await localEdits(undefined, cwd, "src", { files: [tabs, aside], baseline }), "none");
    assert.deepEqual(fetched.sort(), ["templates-v1.0.0", "templates-v1.1.0"]);
  });
});

test("a nested install root maps to the starter's src", async () => {
  await withProject(async (root) => {
    const tree = path.join(root, "tree");
    const cwd = path.join(root, "site");
    writeFiles(tree, { "src/components/ui/tabs/Tabs.astro": "<tabs />" });
    writeFiles(cwd, { "docs/src/components/ui/tabs/Tabs.astro": "<tabs />" });
    const baseline = starterBaseline({ templatesTag: "templates-v1.0.0" }, "docs/src", tree);
    const files = ["docs/src/components/ui/tabs/Tabs.astro"];
    assert.equal(await localEdits(undefined, cwd, "docs/src", { files, baseline }), "none");
  });
});

// `--overwrite` without a terminal (these tests run with stdin and stdout piped)
// and without `--yes`: files the user edited are kept and listed, files they
// didn't are replaced. `keptUnasked` is what makes the command exit 1.

test("--overwrite without a terminal keeps edited components and their edited dependencies, replaces the rest", async () => {
  await withProject(async (cwd) => {
    const badge = (c: string) => item("badge", "registry:ui", [{ path: "components/ui/badge/Badge.astro", content: c }]);
    const crumbs = (c: string) => item("breadcrumbs", "registry:ui", [{ path: "components/ui/breadcrumbs/Breadcrumbs.astro", content: c }]);
    await installComponents([dialog("V1"), badge("B1"), crumbs("C1")], opts(cwd));
    // The site redesigned Badge (a dependency) and Breadcrumbs; Dialog is untouched.
    writeFiles(cwd, {
      "src/components/ui/badge/Badge.astro": "B1 redesigned",
      "src/components/ui/breadcrumbs/Breadcrumbs.astro": "C1 redesigned",
    });
    const recorded = new Map([
      ...recordFor("dialog", dialog("V1").files),
      ...recordFor("badge", badge("B1").files),
      ...recordFor("breadcrumbs", crumbs("C1").files),
    ]);
    const report = await installComponents([dialog("V2"), badge("B2"), crumbs("C2")], opts(cwd, { overwrite: true, recorded }));
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V2");
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/badge/Badge.astro"), "utf8"), "B1 redesigned");
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/breadcrumbs/Breadcrumbs.astro"), "utf8"), "C1 redesigned");
    assert.deepEqual(report.replaced, [path.join("src", "components/ui/dialog/Dialog.astro")]);
    const badgeFile = path.join("src", "components/ui/badge/Badge.astro");
    const crumbsFile = path.join("src", "components/ui/breadcrumbs/Breadcrumbs.astro");
    assert.deepEqual(report.keptUnasked, [
      { slug: "badge", files: [badgeFile], size: 1, reason: "edited", edited: [badgeFile] },
      { slug: "breadcrumbs", files: [crumbsFile], size: 1, reason: "edited", edited: [crumbsFile] },
    ]);
    assert.deepEqual(report.skipped, ["badge", "breadcrumbs"], "kept components stay out of the install record");
    assert.deepEqual(report.keptDeclined, []);
    assert.deepEqual(report.replacedEdited, []);
  });
});

test("--overwrite --yes replaces edited files too and names the ones that carried edits", async () => {
  await withProject(async (cwd) => {
    await installComponents([dialog("V1")], opts(cwd));
    writeFiles(cwd, { "src/components/ui/dialog/Dialog.astro": "V1 redesigned" });
    const recorded = recordFor("dialog", dialog("V1").files);
    const report = await installComponents([dialog("V2")], opts(cwd, { overwrite: true, yes: true, recorded }));
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V2");
    assert.deepEqual(report.replacedEdited, [path.join("src", "components/ui/dialog/Dialog.astro")]);
    assert.deepEqual(report.keptUnasked, []);
  });
});

test("--overwrite names only the edited file of a component, and keeps the component whole", async () => {
  await withProject(async (cwd) => {
    const names = ["Accordion", "AccordionContent", "AccordionGroup", "AccordionTrigger"];
    const accordion = (v: string) =>
      item("accordion", "registry:ui", names.map((n) => ({ path: `components/ui/accordion/${n}.astro`, content: `${n} ${v}` })));
    await installComponents([accordion("V1")], opts(cwd));
    writeFiles(cwd, { "src/components/ui/accordion/Accordion.astro": "Accordion V1 edited" });
    const files = names.map((n) => path.join("src", `components/ui/accordion/${n}.astro`));

    const report = await installComponents([accordion("V2")], opts(cwd, { overwrite: true, recorded: recordFor("accordion", accordion("V1").files) }));
    assert.deepEqual(report.keptUnasked, [{ slug: "accordion", files, size: 4, reason: "edited", edited: [files[0]!] }]);
    assert.equal(readFileSync(path.join(cwd, files[1]!), "utf8"), "AccordionContent V1", "the component is kept whole");
    assert.match(keptLines(report, "accordion", null).join("\n"), /accordion \(4 files\): src.components.ui.accordion.Accordion\.astro has local edits/);

    // A record from before per-file hashes can't say which file.
    const old = await installComponents([accordion("V2")], opts(cwd, { overwrite: true, recorded: oldRecordFor("accordion", accordion("V1").files) }));
    assert.deepEqual(old.keptUnasked, [{ slug: "accordion", files, size: 4, reason: "edited" }]);
    assert.match(keptLines(old, "accordion", null).join("\n"), /accordion \(4 files\): it has local edits; its install record predates per-file tracking/);
    // Reinstalling the release it came from: one file differs, the component is still four.
    const same = await installComponents([accordion("V1")], opts(cwd, { overwrite: true, recorded: recordFor("accordion", accordion("V1").files) }));
    assert.deepEqual(same.keptUnasked, [{ slug: "accordion", files: [files[0]!], size: 4, reason: "edited", edited: [files[0]!] }]);
    assert.match(keptLines(same, "accordion", null).join("\n"), /accordion \(4 files\)/);
    // An untouched component under an old record is still unedited.
    writeFiles(cwd, { "src/components/ui/accordion/Accordion.astro": "Accordion V1" });
    const clean = await installComponents([accordion("V2")], opts(cwd, { overwrite: true, recorded: oldRecordFor("accordion", accordion("V1").files) }));
    assert.deepEqual(clean.keptUnasked, []);
    assert.equal(clean.replaced.length, 4);
  });
});

test("--overwrite --yes without an install record consults the starter release; when it can't, the files count as not compared", async () => {
  await withProject(async (cwd) => {
    await installComponents([dialog("V1")], opts(cwd));
    let fetches = 0;
    const starter = starterBaseline({ templatesTag: "templates-v1.0.0" }, "src", undefined, async () => {
      fetches++;
      throw new Error("offline");
    });
    const report = await installComponents([dialog("V2")], opts(cwd, { overwrite: true, yes: true, starter }));
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V2");
    assert.equal(fetches, 1, "the starter release is consulted so the report can say what was discarded");
    assert.equal(report.replacedUncompared, 1);
    assert.deepEqual(report.replacedEdited, []);
  });
});

test("--overwrite --yes on an edited starter component counts it as a local edit", async () => {
  await withProject(async (root) => {
    const tree = path.join(root, "tree");
    const cwd = path.join(root, "site");
    writeFiles(tree, { "package.json": "{}", "src/components/ui/dialog/Dialog.astro": "V1" });
    writeFiles(cwd, { "src/components/ui/dialog/Dialog.astro": "V1 redesigned" });
    const starter = starterBaseline({ templatesTag: "templates-v1.0.0" }, "src", tree);
    const report = await installComponents([dialog("V2")], opts(cwd, { overwrite: true, yes: true, starter }));
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V2");
    assert.deepEqual(report.replacedEdited, [path.join("src", "components/ui/dialog/Dialog.astro")]);
  });
});

test("--overwrite in a terminal asks per edited component; no keeps it in the same report block", async () => {
  await withProject(async (cwd) => {
    await installComponents([dialog("V1"), cn("C1")], opts(cwd));
    writeFiles(cwd, { "src/components/ui/dialog/Dialog.astro": "V1 redesigned", "src/lib/cn.ts": "C1 edited" });
    const recorded = new Map([...recordFor("dialog", dialog("V1").files), ...recordFor("cn", cn("C1").files)]);
    const asked: string[] = [];
    const answers: Record<string, boolean> = { dialog: false, cn: true };
    const prompts: Prompts = {
      confirm: (async ({ message }: { message: string }) => {
        const slug = message.split(" ")[0]!;
        asked.push(slug);
        return answers[slug]!;
      }) as Prompts["confirm"],
      select: (async () => "skip") as Prompts["select"],
    };
    const report = await installComponents([dialog("V2"), cn("C2")], opts(cwd, { overwrite: true, recorded, interactive: true, prompts }));
    assert.deepEqual(asked, ["dialog", "cn"]);
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V1 redesigned");
    assert.equal(readFileSync(path.join(cwd, "src/lib/cn.ts"), "utf8"), "C2");
    const dialogFile = path.join("src", "components/ui/dialog/Dialog.astro");
    assert.deepEqual(report.keptDeclined, [{ slug: "dialog", files: [dialogFile], size: 1, reason: "edited", edited: [dialogFile] }]);
    assert.deepEqual(report.keptUnasked, []);
    assert.deepEqual(report.skipped, ["dialog"]);
  });
});

test("--overwrite without a terminal and without a record consults the starter release; when it can't, the component is kept as not compared", async () => {
  await withProject(async (cwd) => {
    await installComponents([dialog("V1")], opts(cwd));
    const offline = starterBaseline({ templatesTag: "templates-v1.0.0" }, "src", undefined, () => Promise.reject(new Error("offline")));
    const report = await installComponents([dialog("V2")], opts(cwd, { overwrite: true, starter: offline }));
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V1");
    assert.deepEqual(report.keptUnasked, [
      { slug: "dialog", files: [path.join("src", "components/ui/dialog/Dialog.astro")], size: 1, reason: "unknown" },
    ]);
  });
});

test("--overwrite without a terminal replaces an unedited component by its record without fetching", async () => {
  await withProject(async (cwd) => {
    await installComponents([dialog("V1")], opts(cwd));
    let fetches = 0;
    const starter = starterBaseline({ templatesTag: "templates-v1.0.0" }, "src", undefined, async () => {
      fetches++;
      throw new Error("unexpected fetch");
    });
    const recorded = recordFor("dialog", dialog("V1").files);
    const report = await installComponents([dialog("V2")], opts(cwd, { overwrite: true, starter, recorded }));
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V2");
    assert.deepEqual(report.replaced, [path.join("src", "components/ui/dialog/Dialog.astro")]);
    assert.equal(fetches, 0);
    assert.deepEqual(report.keptUnasked, []);
  });
});

test("a lib item under --overwrite follows the same rule as a component", async () => {
  await withProject(async (cwd) => {
    await installComponents([cn("C1")], opts(cwd));
    writeFiles(cwd, { "src/lib/cn.ts": "C1 edited" });
    const recorded = recordFor("cn", cn("C1").files);
    const report = await installComponents([cn("C2")], opts(cwd, { overwrite: true, recorded }));
    assert.equal(readFileSync(path.join(cwd, "src/lib/cn.ts"), "utf8"), "C1 edited");
    assert.deepEqual(report.keptUnasked.map((k) => k.slug), ["cn"]);
  });
});

const kept = (slug: string, reason: KeptComponent["reason"] = "edited"): KeptComponent => ({
  slug,
  files: [`src/components/ui/${slug}/${slug}.astro`],
  size: 1,
  reason,
});
const none = { keptUnasked: [], keptDeclined: [] };

test("the kept block names each component's replace command and the whole tree's", () => {
  const lines = keptLines({ ...none, keptUnasked: [kept("badge"), kept("breadcrumbs")] }, "api-layout", null).join("\n");
  assert.match(lines, /Kept 2 components with local edits \(no terminal to ask\)/);
  assert.match(lines, /nimbus-docs add badge --overwrite --yes/);
  assert.match(lines, /nimbus-docs add breadcrumbs --overwrite --yes/);
  assert.match(lines, /Or everything above: .*nimbus-docs add api-layout --overwrite --yes/);
  assert.match(lines, /commit, run one, and review with `git diff`/);
  assert.doesNotMatch(lines, /nimbus-docs diff/, "diff compares starter files, not registry components");
});

test("the kept block names each command once", () => {
  const single = keptLines({ ...none, keptDeclined: [kept("badge")] }, "badge", null).join("\n");
  assert.equal(single.match(/add badge --overwrite --yes/g)?.length, 1);
  assert.doesNotMatch(single, /Or everything above/);
  assert.match(single, /you answered no/);
  // The requested component kept with a dependency: its command is the whole tree's.
  const both = keptLines({ ...none, keptUnasked: [kept("badge"), kept("api-layout")] }, "api-layout", null).join("\n");
  assert.equal(both.match(/add api-layout --overwrite --yes/g)?.length, 1);
  assert.equal(both.match(/add badge --overwrite --yes/g)?.length, 1);
});

test("the kept block says why files couldn't be compared", () => {
  const unknown = { ...none, keptUnasked: [kept("badge", "unknown")] };
  const text = (starter: { error: Error | null } | null) => keptLines(unknown, "badge", starter).join("\n");
  assert.match(text(null), /Could not compare: no recorded content hash or starter release/);
  const rateLimited = new Error("GitHub rate-limited the download (403).\nRepo: x · tag: y\n  • --to <tag>");
  assert.match(text({ error: rateLimited }), /Could not compare: GitHub rate-limited the download \(403\)\.\n.*GIGET_AUTH.*--template-dir/);
  assert.doesNotMatch(text({ error: rateLimited }), /--to/, "add takes no --to");
  assert.match(text({ error: null }), /the starter didn't ship these files/);
  assert.doesNotMatch(text(null), /\binit\b/);
  assert.deepEqual(keptLines(none, "badge", null), []);
});

test("the register hint is skipped once components.ts imports the component", () => {
  const tabs = item("tabs", "registry:ui", [
    { path: "components/ui/tabs/index.ts", content: 'export { Tabs, TabItem, TabsList } from "./Tabs.astro";\n' },
  ]);
  assert.equal(registerHint([tabs], "tabs", "src", 'import { Tabs, TabItem } from "./components/ui/tabs";\n'), null);
  assert.match(registerHint([tabs], "tabs", "src", "// Tabs is great\n") ?? "", /register in src\/components\.ts/);
  const map = (entries: string) => `export const components = { ${entries} };\n`;
  assert.equal(registerHint([tabs], "tabs", "src", `import { Tabs as T } from "@/components/ui/tabs";\n${map("Tabs: T")}`), null);
  // Imported but not in the map, or only in a comment: still unregistered.
  const hint = /register in src\/components\.ts/;
  assert.match(registerHint([tabs], "tabs", "src", `import { Tabs } from "./components/ui/tabs";\n${map("Aside")}`) ?? "", hint);
  assert.match(registerHint([tabs], "tabs", "src", `// import { Tabs } from "./components/ui/tabs";\n${map("Tabs")}`) ?? "", hint);
  assert.match(registerHint([tabs], "tabs", "src", `import { Tabs } from "./components/ui/tabs";\n${map('Aside: "Tabs"')}`) ?? "", hint);
  // Used only as a key, the import isn't registered; as a value it is.
  assert.match(registerHint([tabs], "tabs", "src", `import { Tabs } from "./components/ui/tabs";\n${map("Tabs: Other")}`) ?? "", hint);
  assert.equal(registerHint([tabs], "tabs", "src", `import { Tabs } from "./components/ui/tabs";\n${map("Tabs: Tabs")}`), null);
});
