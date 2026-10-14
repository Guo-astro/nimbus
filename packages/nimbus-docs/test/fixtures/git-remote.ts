// A work tree and the bare repository it pushes to, standing in for a remote
// a content source fetches from.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  }).trim();

export interface GitRemote {
  work: string;
  bare: string;
  /** Write files in the work tree, commit, push; returns the new commit. */
  commit: (files: Record<string, string>, message?: string) => Promise<string>;
}

export async function gitRemote(root: string, files: Record<string, string>): Promise<GitRemote & { first: string }> {
  const work = path.join(root, "sdk-work");
  const bare = path.join(root, "sdk.git");
  const writeAll = async (entries: Record<string, string>) => {
    for (const [relative, contents] of Object.entries(entries)) {
      await mkdir(path.dirname(path.join(work, relative)), { recursive: true });
      await writeFile(path.join(work, relative), contents, "utf8");
    }
  };
  await writeAll(files);
  git(root, "init", "-q", "-b", "main", work);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "docs");
  git(root, "clone", "-q", "--bare", work, bare);
  git(bare, "config", "uploadpack.allowFilter", "true");
  git(work, "remote", "add", "origin", bare);
  const commit = async (entries: Record<string, string>, message = "update") => {
    await writeAll(entries);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", message);
    git(work, "push", "-q", "origin", "main");
    return git(work, "rev-parse", "HEAD");
  };
  return { work, bare, commit, first: git(work, "rev-parse", "HEAD") };
}
