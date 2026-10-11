// `add --overwrite` is the upgrade verb; `--yes` never clobbers owned files.
// Tests run non-interactively (no TTY), which exercises the CI-safe path.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { installComponents, localEdits, registerHint, type InstallOptions } from "../src/cli/component.js";
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

    const report = await installComponents([dialog("V2")], opts(cwd, { overwrite: true }));
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

    const replaced = await installComponents([cn("V2")], opts(cwd, { overwrite: true }));
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
    const report = await installComponents([item("dialog", "registry:ui", files("C2"))], opts(cwd, { overwrite: true }));
    assert.deepEqual(report.replaced, [path.join("src", "components/ui/dialog/DialogContent.astro")]);
    assert.deepEqual(report.written, report.replaced);
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
    assert.equal(localEdits(record, cwd, "src"), "none");
    write("src/components/ui/x/X.astro", "<x edited />\n");
    assert.equal(localEdits(record, cwd, "src"), "edited");
    assert.equal(localEdits(undefined, cwd, "src"), "unknown");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the register hint is skipped once components.ts imports the component", () => {
  const tabs = item("tabs", "registry:ui", [
    { path: "components/ui/tabs/index.ts", content: 'export { Tabs, TabItem, TabsList } from "./Tabs.astro";\n' },
  ]);
  assert.equal(registerHint([tabs], "tabs", "src", 'import { Tabs, TabItem } from "./components/ui/tabs";\n'), null);
  assert.match(registerHint([tabs], "tabs", "src", "// Tabs is great\n") ?? "", /register in src\/components\.ts/);
});
