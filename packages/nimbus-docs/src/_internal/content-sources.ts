/**
 * Content sources: git repositories whose files a collection or an API spec
 * reads at build time (`sources` in the Nimbus config).
 *
 * A snapshot is identified by `(repo, ref as configured, path)` and holds one
 * resolved commit, at `.nimbus/sources/<name>/<identity>/<commit>/`, made by
 * a sparse, blob-filtered, depth-1 fetch whose `.git` is then deleted. A
 * pinned commit is a cache hit forever and makes no network call; a branch or
 * tag is resolved with one `git ls-remote` per build. When the remote can't
 * be reached, a floating ref builds from the snapshot last selected for the
 * same identity, never another declaration's.
 *
 * Readers (a build, a dev server, `lint`, `check`) hold a lease on the
 * snapshot they read; pruning removes only unleased snapshots that no
 * declared identity selects. Selecting a snapshot and leasing it, and
 * pruning, run under one project lock (`.nimbus/sources/.lock`), so a pruner
 * can't remove a snapshot between its selection and its lease. Fetching runs
 * outside the lock, into a temporary folder renamed into place, so readers
 * only ever see complete snapshots.
 *
 * Nimbus never holds a credential: a `repo` with one is refused by config
 * validation, git authenticates through its own helpers, and git's output has
 * URL userinfo removed before it reaches a message.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ApiSpec, ContentSource, NimbusConfig } from "../types.js";
import { authorError } from "./author-error.js";
import { preparedMarkdownRootKey } from "./prepared-markdown-registry.js";
import { SOURCES_DIR } from "./source-paths.js";
import {
  isCommitRef,
  isSpecFromSource,
  normalizeSourcePath,
  redactRepo,
  redactUrlUserinfo,
  repoCredentialFault,
} from "./source-repo.js";

export { SOURCES_DIR } from "./source-paths.js";
export { isCommitRef, isSpecFromSource, normalizeSourcePath } from "./source-repo.js";

const execFileAsync = promisify(execFile);

/** Written into a finished snapshot before it is renamed into place. */
export const SOURCE_MARKER = ".nimbus-source.json";
const MARKER_VERSION = 2;
const COMMIT = /^[0-9a-f]{40}$/;
const IDENTITY = /^[0-9a-f]{16}$/;

const RESOLVE_TIMEOUT_ENV = "NIMBUS_SOURCES_RESOLVE_TIMEOUT";
const FETCH_TIMEOUT_ENV = "NIMBUS_SOURCES_FETCH_TIMEOUT";
const DEFAULT_RESOLVE_TIMEOUT = 30;
const DEFAULT_FETCH_TIMEOUT = 600;

/** A lock held longer than this is broken. */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5 * 60_000;
const LEASE_REFRESH_MS = 60_000;
/** A lease written from another host is live while refreshed this recently. */
const FOREIGN_LEASE_TTL_MS = 10 * 60_000;
/** A temporary fetch folder older than this belongs to a dead fetch. */
const TMP_STALE_MS = 60 * 60_000;

type Log = (level: "info" | "warn", message: string) => void;


function timeoutMs(name: string, fallbackSeconds: number): number {
  const raw = process.env[name];
  const seconds = raw === undefined ? NaN : Number(raw);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds) * 1000;
}

/**
 * The remote git is given: a relative local path resolves against the
 * project root (git would resolve it against its own working folder); URLs,
 * scp-like remotes and absolute paths pass through.
 */
export function resolveSourceRepo(repo: string, projectRoot: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo)) return repo;
  // scp-like `host:path` / `user@host:path` (a slash before the colon makes it a path).
  if (/^[^/\\]+:/.test(repo) && !/^[A-Za-z]:[\\/]/.test(repo)) return repo;
  return path.isAbsolute(repo) ? repo : path.resolve(projectRoot, repo);
}

async function git(args: string[], options: { cwd?: string; timeout: number }): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeout,
      // Credentials stay git's: its helpers, SSH, or `extraHeader` through
      // GIT_CONFIG_*. No prompt, so a missing one fails at once.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string; killed?: boolean };
    const text = failure.killed
      ? `git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} timed out after ${options.timeout / 1000}s`
      : failure.stderr?.trim() || failure.message || String(error);
    throw new Error(redactUrlUserinfo(text));
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function sourcesRoot(projectRoot: string): string {
  return path.join(projectRoot, SOURCES_DIR);
}

export function sourceIdentity(repo: string, ref: string, sourcePath: string): string {
  return createHash("sha256")
    .update(JSON.stringify([repo, ref, sourcePath]))
    .digest("hex")
    .slice(0, 16);
}

interface SourceMarker {
  version: number;
  repo: string;
  ref: string;
  path: string;
  commit: string;
  fetchedAt: string;
}

function readMarker(commitDir: string): SourceMarker | undefined {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(commitDir, SOURCE_MARKER), "utf8")) as SourceMarker;
    return marker.version === MARKER_VERSION && COMMIT.test(marker.commit) ? marker : undefined;
  } catch {
    return undefined;
  }
}

interface SelectedRecord {
  commit: string;
  selectedAt: string;
}

function readSelected(identityDir: string): SelectedRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(identityDir, "selected.json"), "utf8")) as SelectedRecord;
    return COMMIT.test(record.commit) ? record : undefined;
  } catch {
    return undefined;
  }
}

function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

interface LockOwner {
  pid: number;
  host: string;
  startedAt: number;
  token: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

function lockIsStale(lockDir: string, owner: LockOwner | undefined): boolean {
  if (owner) {
    if (owner.host === os.hostname() && !pidAlive(owner.pid)) return true;
    return Date.now() - owner.startedAt > LOCK_STALE_MS;
  }
  // Created but no owner written yet, or left half-made by a killed process.
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

const sameOwner = (a: LockOwner | undefined, b: LockOwner | undefined) =>
  a === undefined ? b === undefined : b !== undefined && a.token === b.token;

/**
 * Break a stale lock without racing another breaker: only one rename of
 * `.lock` wins, and the winner deletes only the owner it observed.
 */
function breakLock(lockDir: string, observed: LockOwner | undefined, log?: Log): void {
  const aside = `${lockDir}.stale-${randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockDir, aside);
  } catch {
    return; // Another process broke or released it first.
  }
  const moved = readOwner(aside);
  if (sameOwner(moved, observed)) {
    fs.rmSync(aside, { recursive: true, force: true });
    log?.(
      "warn",
      moved
        ? `nimbus: broke a stale ${SOURCES_DIR} lock held by pid ${moved.pid} on ${moved.host} since ${new Date(moved.startedAt).toISOString()}.`
        : `nimbus: broke a stale ${SOURCES_DIR} lock with no owner.`,
    );
    return;
  }
  // A live owner took the lock between our read and our rename: put it back.
  if (!fs.existsSync(lockDir)) {
    try {
      fs.renameSync(aside, lockDir);
    } catch {
      // Taken again meanwhile; the live owner's release will find it gone.
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withSourcesLock<T>(
  projectRoot: string,
  operation: () => T | Promise<T>,
  log?: Log,
): Promise<T> {
  const root = sourcesRoot(projectRoot);
  fs.mkdirSync(root, { recursive: true });
  const lockDir = path.join(root, ".lock");
  const me: LockOwner = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: Date.now(),
    token: randomBytes(8).toString("hex"),
  };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      me.startedAt = Date.now();
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(me));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readOwner(lockDir);
      if (lockIsStale(lockDir, owner)) {
        breakLock(lockDir, owner, log);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `nimbus-docs: timed out waiting for ${SOURCES_DIR}/.lock` +
            (owner ? `, held by pid ${owner.pid} on ${owner.host}.` : "."),
        );
      }
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return await operation();
  } finally {
    if (sameOwner(readOwner(lockDir), me)) fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

interface LeaseRecord {
  pid: number;
  host: string;
}

const heldLeases = new Map<string, Set<string>>();
let refreshTimer: NodeJS.Timeout | undefined;
let exitHookInstalled = false;

function allHeldLeases(): string[] {
  return [...heldLeases.values()].flatMap((set) => [...set]);
}

function startLeaseRefresh(): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const lease of allHeldLeases()) fs.rmSync(lease, { force: true });
    });
  }
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    const now = new Date();
    for (const lease of allHeldLeases()) {
      try {
        fs.utimesSync(lease, now, now);
      } catch {
        // Removed by its owner meanwhile.
      }
    }
  }, LEASE_REFRESH_MS);
  refreshTimer.unref();
}

/** Create a lease on a snapshot. Call under the lock. */
function createLease(projectRoot: string, commitDir: string): string {
  const leases = `${commitDir}.leases`;
  fs.mkdirSync(leases, { recursive: true });
  const host = os.hostname();
  const file = path.join(
    leases,
    `${host.replace(/[^A-Za-z0-9.-]/g, "_")}-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host } satisfies LeaseRecord));
  const key = preparedMarkdownRootKey(projectRoot);
  let set = heldLeases.get(key);
  if (!set) heldLeases.set(key, (set = new Set()));
  set.add(file);
  startLeaseRefresh();
  return file;
}

function leaseIsLive(file: string): boolean {
  let record: LeaseRecord;
  let mtime: number;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8")) as LeaseRecord;
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  if (record.host === os.hostname()) return pidAlive(record.pid);
  return Date.now() - mtime < FOREIGN_LEASE_TTL_MS;
}

function hasLiveLease(commitDir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(`${commitDir}.leases`);
  } catch {
    return false;
  }
  return entries.some((entry) => leaseIsLive(path.join(`${commitDir}.leases`, entry)));
}

/** Release every lease this process holds in a project (a build or dev server finishing). */
export function releaseContentSourceLeases(projectRoot: string): void {
  if (!projectRoot) return;
  let key: string;
  try {
    key = preparedMarkdownRootKey(projectRoot);
  } catch {
    return;
  }
  for (const lease of heldLeases.get(key) ?? []) fs.rmSync(lease, { force: true });
  heldLeases.delete(key);
  if (heldLeases.size === 0 && refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Remove every snapshot that no declared identity selects and no live lease
 * names, and temporary fetch folders older than an hour. Moves under the
 * lock, deletes outside it.
 */
export async function pruneContentSources(
  projectRoot: string,
  declared: ReadonlyMap<string, string>,
  log?: Log,
): Promise<void> {
  const root = sourcesRoot(projectRoot);
  if (!fs.existsSync(root)) return;
  const trash = path.join(root, ".trash", randomBytes(6).toString("hex"));
  let moved = 0;
  const discard = (target: string) => {
    if (!fs.existsSync(target)) return;
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(target, path.join(trash, `${moved++}`));
  };
  await withSourcesLock(
    projectRoot,
    () => {
      for (const name of fs.readdirSync(root)) {
        if (name.startsWith(".") || name === "current.json") continue;
        const nameDir = path.join(root, name);
        if (!fs.statSync(nameDir).isDirectory()) continue;
        for (const identity of fs.readdirSync(nameDir)) {
          const identityDir = path.join(nameDir, identity);
          if (!IDENTITY.test(identity) || !fs.statSync(identityDir).isDirectory()) continue;
          const keep = declared.get(`${name}/${identity}`);
          let kept = 0;
          for (const entry of fs.readdirSync(identityDir)) {
            const full = path.join(identityDir, entry);
            if (COMMIT.test(entry)) {
              if (entry === keep || hasLiveLease(full)) {
                kept += 1;
                continue;
              }
              discard(full);
              if (fs.existsSync(`${full}.leases`)) discard(`${full}.leases`);
            } else if (/^[0-9a-f]{40}\.tmp-/.test(entry)) {
              try {
                if (Date.now() - fs.statSync(full).mtimeMs > TMP_STALE_MS) discard(full);
              } catch {
                // Renamed into place meanwhile.
              }
            } else if (/^[0-9a-f]{40}\.leases$/.test(entry)) {
              if (!fs.existsSync(full.slice(0, -".leases".length)) && !hasLiveLease(full.slice(0, -".leases".length))) {
                discard(full);
              }
            }
          }
          if (kept === 0 && keep === undefined) {
            const rest = fs.readdirSync(identityDir).filter((entry) => !/\.tmp-/.test(entry));
            if (rest.every((entry) => entry === "selected.json")) discard(identityDir);
          }
        }
        if (fs.readdirSync(nameDir).length === 0) fs.rmdirSync(nameDir);
      }
    },
    log,
  );
  if (moved > 0) fs.rmSync(trash, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Resolve and fetch
// ---------------------------------------------------------------------------

export interface SourceSnapshot {
  name: string;
  identity: string;
  commit: string;
  /** The source's `path`, normalised; `""` is the repository root. */
  path: string;
  /** Absolute snapshot folder (the repository layout, sparse). */
  dir: string;
  /** Absolute folder of the source's `path` inside the snapshot. */
  contentDir: string;
  /** The ref is a branch or tag, so the commit can change between builds. */
  floating: boolean;
}

/** A fetch failure the author fixes in the config, never covered by the fallback. */
class SourceConfigError extends Error {}

const SHA_REFUSED =
  /not our ref|unadvertised object|allowReachableSHA1InWant|allowAnySHA1InWant|Server does not allow/i;

async function resolveRef(repo: string, ref: string): Promise<string> {
  // The `^{}` pattern asks for an annotated tag's peeled commit, which
  // ls-remote prints only when a pattern names it.
  // A full ref name (`refs/pull/12/head`, `refs/heads/main`) is asked for as
  // written; a short name as a branch or a tag.
  const patterns = ref.startsWith("refs/")
    ? [ref, `${ref}^{}`]
    : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
  const out = await git(["ls-remote", "--", repo, ...patterns], {
    timeout: timeoutMs(RESOLVE_TIMEOUT_ENV, DEFAULT_RESOLVE_TIMEOUT),
  });
  const lines = out.split("\n").filter((line) => line.trim());
  // A branch wins over a tag of the same name; an annotated tag lists the
  // tag object first and the commit it points at as `<ref>^{}`.
  const branch = lines.find((line) => line.endsWith(`\trefs/heads/${ref}`));
  const peeled = lines.find((line) => line.endsWith("^{}"));
  const commit = (branch ?? peeled ?? lines[0])?.split(/\s+/)[0];
  if (!commit || !COMMIT.test(commit)) throw new SourceConfigError(`ref "${ref}" was not found on the remote`);
  return commit;
}

/**
 * Fetch `commit` into `<identityDir>/<commit>/`: into a temporary folder,
 * renamed into place. When another process renamed the same commit first,
 * its snapshot (the same files by construction) is used and ours dropped.
 */
async function fetchSnapshot(options: {
  repo: string;
  ref: string;
  displayRepo: string;
  sourcePath: string;
  commit: string;
  identityDir: string;
}): Promise<void> {
  const { repo, ref, sourcePath, commit, identityDir } = options;
  const timeout = timeoutMs(FETCH_TIMEOUT_ENV, DEFAULT_FETCH_TIMEOUT);
  const dir = path.join(identityDir, commit);
  const tmp = `${dir}.tmp-${randomBytes(6).toString("hex")}`;
  const run = (args: string[]) => git(["-c", "core.symlinks=false", ...args], { cwd: tmp, timeout });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await run(["init", "-q"]);
    await run(["remote", "add", "origin", "--", repo]);
    if (sourcePath) await run(["sparse-checkout", "set", "--", sourcePath]);
    const fetchArgs = ["fetch", "-q", "--filter=blob:none", "--depth=1", "origin"];
    try {
      await run([...fetchArgs, commit]);
    } catch (error) {
      const message = (error as Error).message;
      if (!SHA_REFUSED.test(message)) throw error;
      if (isCommitRef(ref)) {
        throw new SourceConfigError(
          `${message}\nThe server refuses a fetch by commit; set uploadpack.allowReachableSHA1InWant=true on it, or use a branch or tag name as ref.`,
        );
      }
      await run([...fetchArgs, ref]);
      // An annotated tag's FETCH_HEAD is the tag object; compare its commit.
      const fetched = (await run(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      if (fetched !== commit) {
        throw new SourceConfigError(`ref "${ref}" moved from ${commit.slice(0, 12)} to ${fetched.slice(0, 12)} during the build`);
      }
    }
    await run(["checkout", "-q", "FETCH_HEAD"]);
    if (sourcePath && !fs.existsSync(path.join(tmp, sourcePath))) {
      throw new SourceConfigError(`path "${sourcePath}" does not exist at commit ${commit.slice(0, 12)}`);
    }
    // Snapshots are never updated in place: keep only the files.
    fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
    const marker: SourceMarker = {
      version: MARKER_VERSION,
      repo: options.displayRepo,
      ref,
      path: sourcePath,
      commit,
      fetchedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmp, SOURCE_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    try {
      fs.renameSync(tmp, dir);
    } catch (error) {
      if (!readMarker(dir)) throw error;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

function snapshotOf(name: string, identity: string, identityDir: string, commit: string, sourcePath: string, floating: boolean): SourceSnapshot {
  const dir = path.join(identityDir, commit);
  return {
    name,
    identity,
    commit,
    path: sourcePath,
    dir,
    contentDir: sourcePath ? path.join(dir, sourcePath) : dir,
    floating,
  };
}

/** A declaration's snapshot folder and display, computed without git. */
interface Declaration {
  name: string;
  declared: ContentSource;
  repo: string;
  sourcePath: string;
  displayRepo: string;
  identity: string;
  identityDir: string;
  label: string;
  pinned: boolean;
}

function declaration(name: string, declared: ContentSource, projectRoot: string): Declaration {
  const fault = repoCredentialFault(declared.repo);
  if (fault) {
    throw authorError(
      `nimbus-docs: sources.${name}.repo ${fault} (${redactRepo(declared.repo)}). Nimbus never takes a credential in repo.`,
      "Give the credential to git instead: a credential helper, an SSH key, or http.<url>.extraHeader through GIT_CONFIG_COUNT/GIT_CONFIG_KEY_0/GIT_CONFIG_VALUE_0 in CI.",
    );
  }
  const sourcePath = normalizeSourcePath(declared.path);
  const repo = resolveSourceRepo(declared.repo, projectRoot);
  const displayRepo = redactRepo(declared.repo);
  const identity = sourceIdentity(repo, declared.ref, sourcePath);
  return {
    name,
    declared,
    repo,
    sourcePath,
    displayRepo,
    identity,
    identityDir: path.join(sourcesRoot(projectRoot), name, identity),
    label: `source "${name}" (${displayRepo} @ ${declared.ref})`,
    pinned: isCommitRef(declared.ref),
  };
}

/**
 * The snapshot a declaration selects now, found without git: a pinned ref's
 * commit, a floating ref's last selected one. Undefined when it isn't there.
 * Call under the lock.
 */
function offlineCommit(d: Declaration): string | undefined {
  const commit = d.pinned ? d.declared.ref : readSelected(d.identityDir)?.commit;
  return commit && readMarker(path.join(d.identityDir, commit)) ? commit : undefined;
}

/** A source that could not be fetched and has no snapshot to fall back to. */
class SourceUnavailableError extends Error {
  constructor(
    readonly source: Declaration,
    readonly failure: string | undefined,
  ) {
    super(`could not fetch ${source.label}`);
  }
}

async function resolveOne(
  name: string,
  declared: ContentSource,
  projectRoot: string,
  log: Log,
): Promise<SourceSnapshot> {
  const d = declaration(name, declared, projectRoot);
  const { sourcePath, repo, displayRepo, identity, identityDir, label, pinned } = d;
  const floatingNote = pinned ? "" : ` Ref "${declared.ref}" floats; pin a commit for reproducible builds.`;
  const level = pinned ? "info" : "warn";
  fs.mkdirSync(identityDir, { recursive: true });

  const configError = (error: unknown) =>
    authorError(`nimbus-docs: could not check out ${label}: ${(error as Error).message}.`);

  let commit: string | undefined = pinned ? declared.ref : undefined;
  let failure: string | undefined;
  if (!pinned) {
    try {
      commit = await resolveRef(repo, declared.ref);
    } catch (error) {
      if (error instanceof SourceConfigError) throw configError(error);
      failure = (error as Error).message;
    }
  }

  for (let attempt = 0; commit && attempt < 3; attempt++) {
    const dir = path.join(identityDir, commit);
    let fetched = false;
    if (!readMarker(dir)) {
      try {
        await fetchSnapshot({ repo, ref: declared.ref, displayRepo, sourcePath, commit, identityDir });
        fetched = true;
      } catch (error) {
        // Only a failed transport falls back; a wrong path or a ref that
        // moved mid-build is the author's to fix.
        if (error instanceof SourceConfigError) throw configError(error);
        failure = (error as Error).message;
        break;
      }
    }
    // Select and lease under the lock; a pruner may have removed an
    // unleased snapshot between the fetch and here, so look again.
    const leased = await withSourcesLock(
      projectRoot,
      () => {
        if (!readMarker(dir)) return false;
        writeFileAtomic(
          path.join(identityDir, "selected.json"),
          JSON.stringify({ commit, selectedAt: new Date().toISOString() } satisfies SelectedRecord),
        );
        createLease(projectRoot, dir);
        return true;
      },
      log,
    );
    if (leased) {
      log(level, `nimbus: ${label}: ${fetched ? "fetched" : "using cached"} commit ${commit.slice(0, 12)}.${floatingNote}`);
      return snapshotOf(name, identity, identityDir, commit, sourcePath, !pinned);
    }
  }

  // A floating ref builds from the snapshot last selected for this same
  // identity; another declaration's snapshot is never used.
  if (!pinned) {
    const fallback = await withSourcesLock(
      projectRoot,
      () => {
        const selected = readSelected(identityDir);
        const dir = selected && path.join(identityDir, selected.commit);
        if (!selected || !dir || !readMarker(dir)) return undefined;
        createLease(projectRoot, dir);
        return selected;
      },
      log,
    );
    if (fallback) {
      log(
        "warn",
        `nimbus: could not fetch ${label}: ${failure}. Building from commit ${fallback.commit.slice(0, 12)}, selected ${fallback.selectedAt}.`,
      );
      return snapshotOf(name, identity, identityDir, fallback.commit, sourcePath, true);
    }
  }
  throw new SourceUnavailableError(d, failure);
}

const PRIVATE_REPOSITORIES_DOCS = "https://nimbus-docs.com/writing/content-sources/#private-repositories";

function noSnapshotError(error: SourceUnavailableError, readBy: string | undefined): Error {
  const failure = (error.failure ?? "the snapshot was removed while it was being selected").replace(/\.\s*$/, "");
  return authorError(
    `nimbus-docs: could not fetch ${error.source.label}: ${failure}. ` +
      `No snapshot of this repo, ref and path exists under ${SOURCES_DIR}/${error.source.name}/.` +
      (readBy ? `\n  Read by: ${readBy}.` : "") +
      `\n  Give git a credential: ${PRIVATE_REPOSITORIES_DOCS}`,
  );
}

/** A source with no snapshot this run, in a command that starts without it. */
export interface UnavailableSource {
  /** `source "sdk" (https://github.com/acme/sdk.git @ main)`. */
  label: string;
  /** Git's error; undefined when no git ran (`astro preview`). */
  failure?: string;
}

export interface ResolvedContentSources {
  /** The snapshot each source read this run resolved to, by source name. */
  snapshots: Map<string, SourceSnapshot>;
  /** Sources that resolved to nothing (`degrade` and `offline` only). */
  unavailable: Map<string, UnavailableSource>;
}

export interface ResolveContentSourcesOptions {
  projectRoot: string;
  log: Log;
  /**
   * `fetch` (`astro build`): a source that can't be fetched and has no
   * snapshot fails. `degrade` (`astro dev`, `astro sync`): it is reported
   * unavailable instead, when the failure is git's transport. `offline`
   * (`astro preview`): no git runs; each source reads the snapshot it
   * selects now, nothing is pruned and `current.json` isn't written.
   */
  mode?: "fetch" | "degrade" | "offline";
  /** Sources not fetched: each keeps the snapshot it selects now, found without git. */
  skip?: ReadonlySet<string>;
  /** Sources that never degrade (an `api` entry reads them). */
  required?: ReadonlySet<string>;
  /** Who reads a source (`collection "sdk"`), for the message when it can't be fetched. */
  readBy?: (name: string) => string;
}

/**
 * Resolve every declared source to a leased snapshot, in declaration order,
 * then prune. Writes `.nimbus/sources/current.json` for the tools that read
 * snapshots without the config (`lint`, `check`).
 *
 * A skipped source never runs git and is never leased: it keeps the snapshot
 * its declaration selects now, in the prune and in `current.json`, so `lint`
 * and the next full build still find it.
 */
export async function resolveContentSources(
  sources: NimbusConfig["sources"],
  options: ResolveContentSourcesOptions,
): Promise<ResolvedContentSources> {
  const { projectRoot, log, mode = "fetch", skip, required, readBy } = options;
  const snapshots = new Map<string, SourceSnapshot>();
  const unavailable = new Map<string, UnavailableSource>();
  const entries = Object.entries(sources ?? {});
  if (entries.length === 0 && !fs.existsSync(sourcesRoot(projectRoot))) return { snapshots, unavailable };
  // Kept without being read: skipped sources, by name.
  const kept = new Map<string, SourceSnapshot>();
  for (const [name, source] of entries) {
    if (mode === "offline" || skip?.has(name)) {
      const d = declaration(name, source, projectRoot);
      const lease = mode === "offline";
      const commit = fs.existsSync(d.identityDir)
        ? await withSourcesLock(
            projectRoot,
            () => {
              const found = offlineCommit(d);
              if (found && lease) createLease(projectRoot, path.join(d.identityDir, found));
              return found;
            },
            log,
          )
        : undefined;
      const snapshot = commit && snapshotOf(name, d.identity, d.identityDir, commit, d.sourcePath, !d.pinned);
      if (!lease) {
        if (snapshot) kept.set(name, snapshot);
      } else if (snapshot) {
        log("info", `nimbus: ${d.label}: using cached commit ${commit.slice(0, 12)}.`);
        snapshots.set(name, snapshot);
      } else {
        if (required?.has(name)) {
          // No git ran: the source isn't known to be unreachable, only unfetched.
          const readers = readBy?.(name);
          throw authorError(
            `nimbus-docs: ${d.label} has no snapshot; run astro build first.` + (readers ? `\n  Read by: ${readers}.` : ""),
          );
        }
        unavailable.set(name, { label: d.label });
      }
      continue;
    }
    try {
      snapshots.set(name, await resolveOne(name, source, projectRoot, log));
    } catch (error) {
      if (!(error instanceof SourceUnavailableError)) throw error;
      if (mode === "fetch" || required?.has(name)) throw noSnapshotError(error, readBy?.(name));
      unavailable.set(name, { label: error.source.label, failure: error.failure });
    }
  }
  if (mode === "offline") return { snapshots, unavailable };
  const current = new Map([...snapshots, ...kept]);
  const declared = new Map([...current.values()].map((s) => [`${s.name}/${s.identity}`, s.commit]));
  await pruneContentSources(projectRoot, declared, log);
  writeCurrentSources(projectRoot, new Map(entries.flatMap(([name]) => (current.has(name) ? [[name, current.get(name)!]] : []))));
  return { snapshots, unavailable };
}

// ---------------------------------------------------------------------------
// The selected snapshots, for tools without the config
// ---------------------------------------------------------------------------

interface CurrentSources {
  version: 1;
  sources: Record<string, { dir: string; path: string }>;
}

function writeCurrentSources(projectRoot: string, snapshots: ReadonlyMap<string, SourceSnapshot>): void {
  const file = path.join(sourcesRoot(projectRoot), "current.json");
  if (snapshots.size === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const current: CurrentSources = {
    version: 1,
    sources: Object.fromEntries(
      [...snapshots].map(([name, s]) => [
        name,
        { dir: path.relative(projectRoot, s.dir).split(path.sep).join("/"), path: s.path },
      ]),
    ),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(current, null, 2)}\n`);
}

export interface CurrentSourceSnapshot {
  /** Absolute snapshot folder. */
  dir: string;
  /** Absolute folder of the source's `path`. */
  contentDir: string;
}

/** The snapshots the last build or dev start selected, by source name. */
export function readCurrentSources(projectRoot: string): Map<string, CurrentSourceSnapshot> {
  const out = new Map<string, CurrentSourceSnapshot>();
  let current: CurrentSources;
  try {
    current = JSON.parse(fs.readFileSync(path.join(sourcesRoot(projectRoot), "current.json"), "utf8")) as CurrentSources;
  } catch {
    return out;
  }
  if (current.version !== 1) return out;
  for (const [name, entry] of Object.entries(current.sources ?? {})) {
    const dir = path.resolve(projectRoot, entry.dir);
    if (!dir.startsWith(sourcesRoot(projectRoot) + path.sep) || !readMarker(dir)) continue;
    out.set(name, { dir, contentDir: entry.path ? path.join(dir, entry.path) : dir });
  }
  return out;
}

/**
 * Lease the selected snapshots for a tool that reads them (`lint`,
 * `check`), and return what it may read. Call `release()` when done.
 */
export async function leaseCurrentSources(
  projectRoot: string,
): Promise<{ snapshots: Map<string, CurrentSourceSnapshot>; release: () => void }> {
  if (!fs.existsSync(path.join(sourcesRoot(projectRoot), "current.json"))) {
    return { snapshots: new Map(), release: () => {} };
  }
  const snapshots = await withSourcesLock(projectRoot, () => {
    const current = readCurrentSources(projectRoot);
    for (const snapshot of current.values()) createLease(projectRoot, snapshot.dir);
    return current;
  });
  return { snapshots, release: () => releaseContentSourceLeases(projectRoot) };
}

// ---------------------------------------------------------------------------
// The snapshots of this process, for the loaders
// ---------------------------------------------------------------------------

// Snapshots per project root, filled at `astro:config:setup` and read by the
// loaders `docsCollection({ source })` makes, with the sources this run has
// no snapshot for: skipped by a partial build, or unavailable in a command
// that starts without them.
interface RegisteredSources {
  snapshots: Map<string, SourceSnapshot>;
  skipped: ReadonlySet<string>;
  unavailable: ReadonlySet<string>;
  /** Collections left empty because their source is unavailable. */
  emptied: Set<string>;
}
const registryKey = Symbol.for("@cloudflare/nimbus-docs/content-sources/v3");
const shared = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, RegisteredSources>;
};
const registry = (shared[registryKey] ??= new Map());

export function registerContentSources(
  root: URL | string,
  snapshots: Map<string, SourceSnapshot>,
  missing: { skipped?: Iterable<string>; unavailable?: Iterable<string> } = {},
): void {
  registry.set(preparedMarkdownRootKey(root), {
    snapshots,
    skipped: new Set(missing.skipped),
    unavailable: new Set(missing.unavailable),
    emptied: new Set(),
  });
}

export function resolveContentSource(root: URL | string, name: string): SourceSnapshot | undefined {
  return registry.get(preparedMarkdownRootKey(root))?.snapshots.get(name);
}

/** Why a declared source has no snapshot this run, if it is declared. */
export function missingContentSource(root: URL | string, name: string): "skipped" | "unavailable" | undefined {
  const entry = registry.get(preparedMarkdownRootKey(root));
  if (entry?.skipped.has(name)) return "skipped";
  if (entry?.unavailable.has(name)) return "unavailable";
  return undefined;
}

export function registeredContentSourceNames(root: URL | string): string[] {
  const entry = registry.get(preparedMarkdownRootKey(root));
  return entry ? [...entry.snapshots.keys(), ...entry.skipped, ...entry.unavailable] : [];
}

/** A collection's loader found its source unavailable and left it empty. */
export function recordUnavailableSourceCollection(root: URL | string, collection: string): void {
  registry.get(preparedMarkdownRootKey(root))?.emptied.add(collection);
}

/** The collections left empty because their source is unavailable, after content sync. */
export function unavailableSourceCollections(root: URL | string): string[] {
  return [...(registry.get(preparedMarkdownRootKey(root))?.emptied ?? [])].sort();
}

/**
 * The warning for a source a command starts without: which collections are
 * empty (null when the config doesn't show every read), and git's error.
 */
export function unavailableSourceWarning(
  source: UnavailableSource,
  collections: readonly string[] | null,
  command: string,
): string {
  const empty =
    collections === null
      ? "the collections that read it are empty"
      : collections.length === 1
        ? `collection "${collections[0]}" is empty`
        : `collections ${collections.map((name) => `"${name}"`).join(", ")} are empty`;
  if (command === "preview") {
    // Preview runs no git: the source isn't known to be unreachable, and a
    // build would fetch it.
    const what = collections?.length === 0 ? "nothing reads it" : empty;
    return `nimbus: ${source.label} has no snapshot yet; ${what} (run a build to fetch it).`;
  }
  const tail = source.failure ? ` git: ${source.failure}` : "";
  if (collections?.length === 0) {
    return `nimbus: ${source.label} is unavailable; nothing reads it, but a full build fails until it can be fetched (restart to retry).${tail}`;
  }
  return `nimbus: ${source.label} is unavailable; ${empty} until it can be fetched (restart to retry). A full build fails until then.${tail}`;
}

// ---------------------------------------------------------------------------
// API specs from a source
// ---------------------------------------------------------------------------


interface SpecFromSource {
  /** The `api` entry's collection. */
  collection: string;
  holder: { spec?: unknown };
  source: string;
  path: string;
}

/**
 * The `api[].spec` entries that read through a source, found once when the
 * integration is made: `astro:config:setup` re-runs on a dev restart, and by
 * then the entries hold the snapshot paths of the previous run.
 */
export function collectSourceSpecs(api: readonly ApiSpec[] | undefined): SpecFromSource[] {
  const out: SpecFromSource[] = [];
  for (const entry of api ?? []) {
    for (const holder of entry.versions ?? [entry]) {
      if (isSpecFromSource(holder.spec)) {
        out.push({
          collection: entry.collection,
          holder,
          source: holder.spec.source,
          path: normalizeSourcePath(holder.spec.path),
        });
      }
    }
  }
  return out;
}

/** Point each source-backed spec at its file inside the snapshot, project-relative. */
export function applySourceSpecs(
  specs: readonly SpecFromSource[],
  snapshots: ReadonlyMap<string, SourceSnapshot>,
  projectRoot: string,
): void {
  for (const { holder, source, path: specPath } of specs) {
    const snapshot = snapshots.get(source);
    if (!snapshot) {
      throw authorError(
        `nimbus-docs: an api entry reads its spec from source "${source}", which the Nimbus config doesn't declare in sources.`,
      );
    }
    holder.spec = path.relative(projectRoot, path.join(snapshot.dir, specPath)).split(path.sep).join("/");
  }
}

/**
 * Who reads a source, for the message when it can't be fetched:
 * `collection "sdk" and api entry "widgets"`. `hidden` when the content
 * config may read it in a way its text doesn't show.
 */
export function describeSourceReaders(
  collections: readonly string[],
  apiEntries: readonly string[],
  hidden: boolean,
): string {
  // An `api` entry with versions reads its source once per version.
  const list = (one: string, many: string, names: readonly string[]) => {
    const unique = [...new Set(names)];
    return unique.length === 0 ? [] : [`${unique.length === 1 ? one : many} ${unique.map((name) => `"${name}"`).join(", ")}`];
  };
  const parts = [
    ...list("collection", "collections", collections),
    ...list("api entry", "api entries", apiEntries),
    ...(hidden ? ["collections src/content.config.ts doesn't show"] : []),
  ];
  return parts.length > 0 ? parts.join(" and ") : "nothing; remove it from sources";
}
