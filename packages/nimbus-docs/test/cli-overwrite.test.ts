// `add --overwrite` is the upgrade verb. Without it, `--yes` never clobbers
// owned files; with it, edited files are asked about in a terminal, kept when
// nobody can be asked, and replaced only under `--yes`. Tests run with no TTY.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { installComponents, localEdits, registerHint, starterBaseline, type InstallOptions, type Prompts } from "../src/cli/component.js";
import { bytesHash } from "../src/cli/nimbus-json.js";
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
const recordFor = (slug: string, files: RegistryFile[]) =>
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
// didn't are replaced, and the exit code says the verb didn't complete.


function withExitCode<T>(run: () => Promise<T>): Promise<T> {
  const before = process.exitCode;
  return run().finally(() => {
    process.exitCode = before;
  });
}

test("--overwrite without a terminal keeps edited components and their edited dependencies, replaces the rest, exits 1", async () => {
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
    const report = await withExitCode(async () => {
      const r = await installComponents([dialog("V2"), badge("B2"), crumbs("C2")], opts(cwd, { overwrite: true, recorded }));
      assert.equal(process.exitCode, 1, "the verb did not complete");
      return r;
    });
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V2");
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/badge/Badge.astro"), "utf8"), "B1 redesigned");
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/breadcrumbs/Breadcrumbs.astro"), "utf8"), "C1 redesigned");
    assert.deepEqual(report.replaced, [path.join("src", "components/ui/dialog/Dialog.astro")]);
    assert.deepEqual(report.keptUnasked, [
      { slug: "badge", files: [path.join("src", "components/ui/badge/Badge.astro")], reason: "edited" },
      { slug: "breadcrumbs", files: [path.join("src", "components/ui/breadcrumbs/Breadcrumbs.astro")], reason: "edited" },
    ]);
    assert.deepEqual(report.skipped, ["badge", "breadcrumbs"], "kept components stay out of the install record");
    assert.deepEqual(report.keptDeclined, []);
    assert.equal(report.replacedEdited, 0);
  });
});

test("--overwrite --yes replaces edited files too and says how many carried edits", async () => {
  await withProject(async (cwd) => {
    await installComponents([dialog("V1")], opts(cwd));
    writeFiles(cwd, { "src/components/ui/dialog/Dialog.astro": "V1 redesigned" });
    const recorded = recordFor("dialog", dialog("V1").files);
    const report = await withExitCode(async () => {
      const r = await installComponents([dialog("V2")], opts(cwd, { overwrite: true, yes: true, recorded }));
      assert.notEqual(process.exitCode, 1);
      return r;
    });
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V2");
    assert.equal(report.replacedEdited, 1);
    assert.deepEqual(report.keptUnasked, []);
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
    assert.equal(report.replacedEdited, 0);
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
    assert.equal(report.replacedEdited, 1);
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
    const report = await withExitCode(async () => {
      const r = await installComponents([dialog("V2"), cn("C2")], opts(cwd, { overwrite: true, recorded, interactive: true, prompts }));
      assert.notEqual(process.exitCode, 1, "answering is not a failure");
      return r;
    });
    assert.deepEqual(asked, ["dialog", "cn"]);
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V1 redesigned");
    assert.equal(readFileSync(path.join(cwd, "src/lib/cn.ts"), "utf8"), "C2");
    assert.deepEqual(report.keptDeclined, [
      { slug: "dialog", files: [path.join("src", "components/ui/dialog/Dialog.astro")], reason: "edited" },
    ]);
    assert.deepEqual(report.keptUnasked, []);
    assert.deepEqual(report.skipped, ["dialog"]);
  });
});

test("--overwrite without a terminal and without a record consults the starter release; when it can't, the component is kept as not compared", async () => {
  await withProject(async (cwd) => {
    await installComponents([dialog("V1")], opts(cwd));
    const offline = starterBaseline({ templatesTag: "templates-v1.0.0" }, "src", undefined, () => Promise.reject(new Error("offline")));
    const report = await withExitCode(async () => {
      const r = await installComponents([dialog("V2")], opts(cwd, { overwrite: true, starter: offline }));
      assert.equal(process.exitCode, 1);
      return r;
    });
    assert.equal(readFileSync(path.join(cwd, "src/components/ui/dialog/Dialog.astro"), "utf8"), "V1");
    assert.deepEqual(report.keptUnasked, [
      { slug: "dialog", files: [path.join("src", "components/ui/dialog/Dialog.astro")], reason: "unknown" },
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
    const report = await withExitCode(() => installComponents([cn("C2")], opts(cwd, { overwrite: true, recorded })));
    assert.equal(readFileSync(path.join(cwd, "src/lib/cn.ts"), "utf8"), "C1 edited");
    assert.deepEqual(report.keptUnasked.map((k) => k.slug), ["cn"]);
  });
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
