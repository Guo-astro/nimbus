import assert from "node:assert/strict";
import fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { runPagefind } from "../src/integration.js";
import type { RequestRouteInventoryEntry } from "../src/_internal/request-route-url.js";

function entry(url: string): RequestRouteInventoryEntry {
  return {
    collection: "docs",
    url,
    request: true,
    discoverable: true,
    searchable: true,
    title: url,
    language: "en",
    content: "# Page",
  };
}

async function site(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-pagefind-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// A `pagefind` command that records its arguments and working directory to
// the file named by NIMBUS_PAGEFIND_CAPTURE.
async function pagefindShim(
  t: TestContext,
  binDir: string,
  capture: string,
): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const record = (argsFrom: number) =>
    `require('node:fs').writeFileSync(process.env.NIMBUS_PAGEFIND_CAPTURE, JSON.stringify({ args: process.argv.slice(${argsFrom}), cwd: process.cwd() }))`;
  if (process.platform === "win32") {
    await writeFile(
      path.join(binDir, "pagefind.cmd"),
      `@echo off\r\nnode -e "${record(1)}" -- %*\r\n`,
      "utf8",
    );
  } else {
    const bin = path.join(binDir, "pagefind");
    await writeFile(bin, `#!/usr/bin/env node\n${record(2)};\n`, "utf8");
    await chmod(bin, 0o755);
  }
  const original = process.env.NIMBUS_PAGEFIND_CAPTURE;
  process.env.NIMBUS_PAGEFIND_CAPTURE = capture;
  t.after(() => {
    if (original === undefined) delete process.env.NIMBUS_PAGEFIND_CAPTURE;
    else process.env.NIMBUS_PAGEFIND_CAPTURE = original;
  });
}

function withPath(t: TestContext, value: string): void {
  const original = process.env.PATH;
  process.env.PATH = value;
  t.after(() => {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  });
}

test("Pagefind launches the command on PATH with the site path intact", async (t) => {
  const root = await site(t);
  const binDir = path.join(root, "pagefind bin & tools");
  const siteDir = path.join(root, "site path & output");
  const capture = path.join(root, "pagefind-run.json");
  await mkdir(siteDir, { recursive: true });
  await pagefindShim(t, binDir, capture);
  withPath(t, `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

  await runPagefind(siteDir, [], { root });

  assert.deepEqual(JSON.parse(await readFile(capture, "utf8")).args, [
    "--site",
    siteDir,
  ]);
});

test("Pagefind runs from a workspace's node_modules/.bin, in the project root", async (t) => {
  const workspace = await site(t);
  const project = path.join(workspace, "apps", "docs");
  const siteDir = path.join(project, "dist");
  const capture = path.join(workspace, "pagefind-run.json");
  await mkdir(siteDir, { recursive: true });
  await pagefindShim(t, path.join(workspace, "node_modules", ".bin"), capture);
  withPath(t, path.dirname(process.execPath));

  await runPagefind(siteDir, [], { root: project });

  const run = JSON.parse(await readFile(capture, "utf8"));
  assert.deepEqual(run.args, ["--site", siteDir]);
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(project));
});

test("a Pagefind that isn't installed says to install it; one that fails doesn't", async (t) => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  t.after(() => (console.warn = originalWarn));
  const missing = await site(t);
  withPath(t, path.dirname(process.execPath));
  await runPagefind(missing, [], { root: missing });

  const failing = await site(t);
  await runPagefind(failing, [], {
    root: failing,
    execute: async () => ({
      error: Object.assign(new Error("pagefind exited with code 1"), {
        code: 1,
      }),
      stdout: "",
      stderr: "",
    }),
  });

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Install pagefind as a devDependency/);
  assert.match(
    warnings[1],
    /^\[nimbus-docs\] Pagefind failed: pagefind exited with code 1$/,
  );
});

test("Pagefind removes synthetic files and their empty owned directories", async (t) => {
  const root = await site(t);
  const synthetic = path.join(root, "guide", "index.html");
  let staged = false;

  await runPagefind(root, [entry("/guide/")], {
    execute: async () => {
      staged = fs.existsSync(synthetic);
      return { error: null, stdout: "", stderr: "" };
    },
  });

  assert.equal(staged, true);
  assert.equal(fs.existsSync(synthetic), false);
  assert.equal(fs.existsSync(path.dirname(synthetic)), false);
  assert.equal(fs.existsSync(root), true);
});

test("missing and nonzero Pagefind executions stay nonfatal and clean up", async (t) => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    for (const error of [
      Object.assign(new Error("spawn pagefind ENOENT"), { code: "ENOENT" }),
      Object.assign(new Error("pagefind exited with code 1"), { code: 1 }),
    ]) {
      const root = await site(t);
      await assert.doesNotReject(() =>
        runPagefind(root, [entry("/guide/")], {
          execute: async () => ({ error, stdout: "", stderr: "" }),
        }),
      );
      assert.equal(fs.existsSync(path.join(root, "guide/index.html")), false);
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
});

test("partial Pagefind staging failure removes files already owned", async (t) => {
  const root = await site(t);
  await writeFile(path.join(root, "blocked"), "real file", "utf8");

  await assert.rejects(
    runPagefind(root, [entry("/first/"), entry("/blocked/second/")], {
      execute: async () => {
        assert.fail("Pagefind must not run after staging fails");
      },
    }),
    /not a real directory/,
  );
  assert.equal(fs.existsSync(path.join(root, "first/index.html")), false);
  assert.equal(fs.existsSync(path.join(root, "first")), false);
  assert.equal(await readFile(path.join(root, "blocked"), "utf8"), "real file");
});

test("Pagefind cleans up and closes files when ownership inspection fails", async (t) => {
  const root = await site(t);
  const file = path.join(root, "guide/index.html");
  const originalFstatSync = fs.fstatSync;
  const originalCloseSync = fs.closeSync;
  let closed = false;
  fs.fstatSync = (() => {
    throw new Error("ownership inspection failed");
  }) as typeof fs.fstatSync;
  fs.closeSync = ((descriptor: number) => {
    closed = true;
    return originalCloseSync(descriptor);
  }) as typeof fs.closeSync;
  try {
    await assert.rejects(
      runPagefind(root, [entry("/guide/")]),
      (err: Error) => {
        assert.match(err.message, /ownership inspection failed/);
        assert.ok(err.cause instanceof AggregateError);
        assert.match(
          err.cause.errors.map(String).join("\n"),
          /identity is unavailable/,
        );
        return true;
      },
    );
  } finally {
    fs.fstatSync = originalFstatSync;
    fs.closeSync = originalCloseSync;
  }

  assert.equal(closed, true);
  assert.equal(fs.existsSync(file), true);
});

test("Pagefind refuses to stage through symlinked route directories", async (t) => {
  const root = await site(t);
  const outside = await site(t);
  try {
    await symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("directory links require elevated privileges");
      return;
    }
    throw err;
  }

  await assert.rejects(
    runPagefind(root, [entry("/linked/page/")], {
      execute: async () => ({ error: null, stdout: "", stderr: "" }),
    }),
    /not a real directory/,
  );
  assert.equal(fs.existsSync(path.join(outside, "page/index.html")), false);
  assert.equal(fs.lstatSync(path.join(root, "linked")).isSymbolicLink(), true);
});

test("Pagefind never overwrites or removes pre-existing HTML", async (t) => {
  const root = await site(t);
  const realFile = path.join(root, "guide/index.html");
  await mkdir(path.dirname(realFile), { recursive: true });
  await writeFile(realFile, "real page", "utf8");

  await runPagefind(root, [entry("/guide/")], {
    execute: async () => ({ error: null, stdout: "", stderr: "" }),
  });

  assert.equal(await readFile(realFile, "utf8"), "real page");
});

test("Pagefind does not remove HTML that replaces a staged file", async (t) => {
  const root = await site(t);
  const file = path.join(root, "guide/index.html");
  const replacement = path.join(root, "replacement.html");
  await writeFile(replacement, "replacement page", "utf8");

  await runPagefind(root, [entry("/guide/")], {
    execute: async () => {
      await rm(file);
      await rename(replacement, file);
      return { error: null, stdout: "", stderr: "" };
    },
  });

  assert.equal(await readFile(file, "utf8"), "replacement page");
});

test("Pagefind attempts every cleanup and fails if synthetic files remain", async (t) => {
  const root = await site(t);
  const syntheticFiles = [
    path.join(root, "first/index.html"),
    path.join(root, "second/index.html"),
  ];
  const attempted: string[] = [];
  const originalRmSync = fs.rmSync;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmSyncOptions) => {
    if (syntheticFiles.includes(String(target))) {
      attempted.push(String(target));
      throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    }
    return originalRmSync(target, options);
  }) as typeof fs.rmSync;
  try {
    await assert.rejects(
      runPagefind(root, [entry("/first/"), entry("/second/")], {
        execute: async () => ({ error: null, stdout: "", stderr: "" }),
      }),
      /failed to clean up synthetic Pagefind files/,
    );
  } finally {
    fs.rmSync = originalRmSync;
  }

  assert.deepEqual(attempted.sort(), syntheticFiles.sort());
  assert.ok(syntheticFiles.every((file) => fs.existsSync(file)));
});
