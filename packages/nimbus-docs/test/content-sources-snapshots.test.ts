// Snapshot coordination across processes: leases keep a snapshot a running
// reader uses, concurrent fetches of one commit publish one snapshot, a stale
// lock is broken exactly once, and lease liveness falls on the safe side. And
// credentials: git's own credential reaches no output, and a repository that
// needs one fails at once instead of prompting.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { pruneContentSources, resolveContentSources } from "../src/_internal/content-sources.ts";
import { gitRemote } from "./fixtures/git-remote.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";

const CHILD = fileURLToPath(new URL("./fixtures/sources-child.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const FILES = { "docs/a.md": "---\ntitle: A\n---\n\nA one.\n" };
const quiet = () => {};

function project() {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-snapshots-"));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

function commitsOf(root: string): string[] {
  const dir = path.join(root, ".nimbus/sources/sdk");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((identity) => readdirSync(path.join(dir, identity)).filter((entry) => /^[0-9a-f]{40}$/.test(entry)))
    .sort();
}

function startChild(args: string[]) {
  const child = spawn(process.execPath, ["--import", TSX, CHILD, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => stdout.includes("ready") && resolve());
    child.on("exit", (code) => reject(new Error(`child exited ${code}: ${stderr}`)));
  });
  // Only `hold` children print "ready"; the others' exit isn't a failure here.
  ready.catch(() => {});
  return { child, ready, exited, output: () => ({ stdout, stderr }) };
}

test("a reader's lease keeps its snapshot while a build selects another; the next build after it exits prunes it", async () => {
  const { root, remove } = project();
  try {
    const remote = await gitRemote(path.join(root, "remotes"), FILES);
    const branch = { sdk: { repo: remote.bare, ref: "main", path: "docs" } };
    const holder = startChild(["hold", root, JSON.stringify(branch)]);
    await holder.ready;
    const second = await remote.commit({ "docs/a.md": "---\ntitle: A\n---\n\nA two.\n" });
    await resolveContentSources(branch, { projectRoot: root, log: quiet });
    assert.deepEqual(commitsOf(root), [remote.first, second].sort(), "the held snapshot survives");
    holder.child.stdin.end();
    assert.equal(await holder.exited, 0);
    await resolveContentSources(branch, { projectRoot: root, log: quiet });
    assert.deepEqual(commitsOf(root), [second]);
  } finally {
    remove();
  }
});

test("two builds resolving the same new commit together both succeed and leave one snapshot", async () => {
  const { root, remove } = project();
  try {
    const remote = await gitRemote(path.join(root, "remotes"), FILES);
    const sources = JSON.stringify({ sdk: { repo: remote.bare, ref: remote.first, path: "docs" } });
    const runs = [startChild(["resolve", root, sources]), startChild(["resolve", root, sources])];
    assert.deepEqual(await Promise.all(runs.map((run) => run.exited)), [0, 0], runs.map((run) => run.output().stderr).join("\n"));
    assert.deepEqual(commitsOf(root), [remote.first]);
    const identityDir = path.join(root, ".nimbus/sources/sdk", readdirSync(path.join(root, ".nimbus/sources/sdk"))[0]!);
    assert.ok(!readdirSync(identityDir).some((entry) => entry.includes(".tmp-")), "no temporary folder left");
  } finally {
    remove();
  }
});

test("a lock left by a killed process is broken with a warning, and two breakers leave exactly one owner at a time", async () => {
  const { root, remove } = project();
  try {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const lockDir = path.join(root, ".nimbus/sources/.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: Number(dead.stdout), host: os.hostname(), startedAt: Date.now(), token: "dead" }),
    );
    const log = path.join(root, "lock.log");
    const runs = [startChild(["lock", root, log]), startChild(["lock", root, log])];
    assert.deepEqual(await Promise.all(runs.map((run) => run.exited)), [0, 0]);
    const warnings = runs.map((run) => run.output().stderr).join("");
    assert.match(warnings, new RegExp(`broke a stale \\.nimbus/sources lock held by pid ${dead.stdout}`));
    const events = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" "));
    assert.equal(events.length, 4);
    // enter, exit, enter, exit: the critical sections never overlap.
    assert.deepEqual(events.map(([kind]) => kind), ["enter", "exit", "enter", "exit"]);
    assert.equal(events[0]![1], events[1]![1]);
    assert.ok(!existsSync(lockDir), "the last owner released the lock");
  } finally {
    remove();
  }
});

test("a lease whose pid is dead doesn't block pruning; a foreign host's lease refreshed a minute ago does", async () => {
  const { root, remove } = project();
  try {
    const identityDir = path.join(root, ".nimbus/sources/sdk/0123456789abcdef");
    const make = (commit: string, lease: { pid: number; host: string; age: number }) => {
      const dir = path.join(identityDir, commit);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ".nimbus-source.json"), JSON.stringify({ version: 2, commit }));
      mkdirSync(`${dir}.leases`, { recursive: true });
      const file = path.join(`${dir}.leases`, `${lease.host}-${lease.pid}-x`);
      writeFileSync(file, JSON.stringify({ pid: lease.pid, host: lease.host }));
      const when = new Date(Date.now() - lease.age);
      utimesSync(file, when, when);
    };
    const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    const deadCommit = "a".repeat(40);
    const foreignCommit = "b".repeat(40);
    const staleForeign = "c".repeat(40);
    make(deadCommit, { pid: dead, host: os.hostname(), age: 0 });
    make(foreignCommit, { pid: 1, host: "ci-runner-7", age: 60_000 });
    make(staleForeign, { pid: 1, host: "ci-runner-7", age: 11 * 60_000 });
    await pruneContentSources(root, new Map(), quiet);
    assert.deepEqual(commitsOf(root), [foreignCommit]);
  } finally {
    remove();
  }
});

test("a credential git holds reaches no message, log or file when a fetch fails", async () => {
  const { root, remove } = project();
  const token = "ghs_credential_from_git_9f8e7d";
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "http.extraHeader";
  process.env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const messages: string[] = [];
  try {
    const remote = await gitRemote(path.join(root, "remotes"), FILES);
    const cases = [
      { repo: "http://127.0.0.1:9/acme/sdk.git", ref: "main", path: "docs" }, // unreachable host
      { repo: remote.bare, ref: "no-such-branch", path: "docs" }, // missing ref
      { repo: remote.bare, ref: "main", path: "nowhere" }, // missing path
    ];
    for (const sdk of cases) {
      await assert.rejects(
        resolveContentSources({ sdk }, { projectRoot: root, log: (_level, message) => messages.push(message) }),
        (error: Error & { hint?: string }) => {
          messages.push(error.message, error.hint ?? "");
          return true;
        },
      );
    }
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
    for (const message of messages) {
      assert.ok(!message.includes(token) && !message.includes(encoded), message);
    }
    const files = existsSync(path.join(root, ".nimbus"))
      ? readdirSync(path.join(root, ".nimbus"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    for (const file of files) {
      const text = readFileSync(path.join(file.parentPath, file.name), "utf8");
      assert.ok(!text.includes(token) && !text.includes(encoded), file.name);
    }
  } finally {
    keys.forEach((key, i) => (saved[i] === undefined ? delete process.env[key] : (process.env[key] = saved[i])));
    remove();
  }
});

test("a repository that needs credentials, fetched with none, fails with git's error in seconds and never prompts", async () => {
  const { root, remove } = project();
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  // No user credential helper may answer for the test server.
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "no-gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const started = Date.now();
    await assert.rejects(
      resolveContentSources(
        { sdk: { repo: `http://127.0.0.1:${port}/acme/private.git`, ref: "main", path: "docs" } },
        { projectRoot: root, log: quiet },
      ),
      (error: Error & { hint?: string }) => {
        assert.match(`${error.message}\n${error.hint}`, /terminal prompts disabled|Authentication failed|could not read Username/i);
        return true;
      },
    );
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  } finally {
    for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.close();
    remove();
  }
});
