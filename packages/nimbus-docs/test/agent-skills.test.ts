import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { publishAgentSkills } from "../src/_internal/agent-skills.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateIndex = ajv.compile(
  JSON.parse(
    readFileSync(new URL("./fixtures/agent-skills/index.schema.json", import.meta.url), "utf8"),
  ),
);

function skillsDir(write: (dir: string) => void): string {
  const root = mkdtempSync(path.join(tmpdir(), "nimbus-skills-"));
  const dir = path.join(root, "skills");
  mkdirSync(dir);
  write(dir);
  return dir;
}
function file(dir: string, relative: string, body: string, mode?: number) {
  const target = path.join(dir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  if (mode !== undefined) chmodSync(target, mode);
}
const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** The unit fixture: one single-file skill, one folder skill, plus noise. */
function fixture(dir: string) {
  file(dir, "git-workflow/SKILL.md", "---\nname: git-workflow\ndescription: Follow team Git conventions for branching and commits.\n---\n# Git workflow\n");
  file(dir, "deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy the site with Wrangler.\nmetadata:\n  author: nimbus\n---\nRun `scripts/deploy.sh`, see [references/COMMANDS.md](references/COMMANDS.md).\n");
  file(dir, "deploy/scripts/deploy.sh", "#!/bin/sh\nwrangler deploy\n", 0o755);
  file(dir, "deploy/references/COMMANDS.md", "# Commands\n");
  file(dir, "deploy/.DS_Store", "noise");
  file(dir, "deploy/.cache/tmp", "noise");
  file(dir, "README.md", "not a skill");
}

test("publishes a skill-md entry and a deterministic archive that system tar extracts with SKILL.md at the root", () => {
  const dir = skillsDir(fixture);
  try {
    const first = publishAgentSkills(dir)!;
    const second = publishAgentSkills(dir)!;
    assert.deepEqual(first.warnings, []);
    assert.equal(validateIndex(first.index), true, JSON.stringify(validateIndex.errors));
    // gzip output varies by Node version and OS, so the pinned example masks
    // the archive digest; the tar bytes inside are what must be identical.
    const pinned = JSON.parse(readFileSync(new URL("./fixtures/agent-skills/two-skills.json", import.meta.url), "utf8"));
    const masked = (index: typeof first.index) => ({
      ...index,
      skills: index!.skills.map((skill) =>
        skill.type === "archive" ? { ...skill, digest: "sha256:<archive>" } : skill,
      ),
    });
    assert.deepEqual(masked(first.index), pinned);
    assert.equal(
      sha256(gunzipSync(first.artifacts[1]!.bytes)),
      "sha256:3295bf8502bdaa1ce378a66f99a9566aeaeec0a473194c3f3ed435190407f7d7",
      "tar bytes inside the archive changed",
    );
    assert.deepEqual(
      first.artifacts.map((artifact) => [artifact.pathname, artifact.type]),
      [
        ["/.well-known/agent-skills/index.json", "application/json"],
        ["/.well-known/agent-skills/deploy.tar.gz", "application/gzip"],
        ["/.well-known/agent-skills/git-workflow/SKILL.md", "text/markdown; charset=utf-8"],
      ],
    );
    for (const entry of first.index!.skills) {
      const artifact = first.artifacts.find((item) => item.pathname === entry.url)!;
      assert.equal(entry.digest, sha256(artifact.bytes));
      assert.ok(
        second.artifacts.find((item) => item.pathname === entry.url)!.bytes.equals(artifact.bytes),
        `${entry.url} differs between builds`,
      );
    }
    assert.equal(
      first.artifacts[2]!.bytes.toString(),
      readFileSync(path.join(dir, "git-workflow/SKILL.md"), "utf8"),
    );
    const archive = path.join(dir, "..", "deploy.tar.gz");
    writeFileSync(archive, first.artifacts[1]!.bytes);
    const out = path.join(dir, "..", "extracted");
    mkdirSync(out);
    execFileSync("tar", ["-xzf", archive, "-C", out]);
    assert.deepEqual(
      execFileSync("tar", ["-tzf", archive]).toString().trim().split("\n").sort(),
      ["SKILL.md", "references/COMMANDS.md", "scripts/deploy.sh"],
    );
    assert.equal(readFileSync(path.join(out, "SKILL.md"), "utf8"), readFileSync(path.join(dir, "deploy/SKILL.md"), "utf8"));
    assert.ok(statSync(path.join(out, "scripts/deploy.sh")).mode & 0o100, "executable bit lost");
    assert.equal(statSync(path.join(out, "references/COMMANDS.md")).mode & 0o100, 0);
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("invalid skills and symlinks are skipped with a warning naming the folder and the rule", () => {
  const dir = skillsDir((dir) => {
    fixture(dir);
    file(dir, "Bad-Name/SKILL.md", "---\nname: Bad-Name\ndescription: x\n---\n");
    file(dir, "mismatch/SKILL.md", "---\nname: other\ndescription: x\n---\n");
    file(dir, "no-frontmatter/SKILL.md", "# Just text\n");
    file(dir, "long/SKILL.md", `---\nname: long\ndescription: ${"x".repeat(1025)}\n---\n`);
    file(dir, "empty/notes.md", "no SKILL.md here");
    file(dir, "linked/SKILL.md", "---\nname: linked\ndescription: has a symlinked file\n---\n");
    file(dir, "unquoted/SKILL.md", "---\nname: unquoted\ndescription: Deploy the docs. Use when: shipping\n---\n");
    file(dir, "2024/SKILL.md", "---\nname: 2024\ndescription: 2024\n---\n");
    file(dir, "bom/SKILL.md", "\uFEFF---\nname: bom\ndescription: starts with a byte order mark\n---  \nBody\n");
    file(dir, "list/SKILL.md", "---\n- not\n- a map\n---\n");
    mkdirSync(path.join(dir, "link-skill"));
    symlinkSync(path.join(dir, "deploy/SKILL.md"), path.join(dir, "link-skill/SKILL.md"));
    symlinkSync(path.join(dir, "deploy/scripts/deploy.sh"), path.join(dir, "linked/deploy.sh"));
    symlinkSync(path.join(dir, "deploy"), path.join(dir, "alias"));
  });
  try {
    const result = publishAgentSkills(dir)!;
    assert.deepEqual(result.index!.skills.map((skill) => skill.name), ["2024", "bom", "deploy", "git-workflow", "linked"]);
    assert.equal(result.index!.skills[0]!.description, "2024");
    assert.equal(result.index!.skills[4]!.type, "skill-md");
    assert.deepEqual(result.warnings.sort(), [
      "nimbus-docs: skills/Bad-Name: skipped, `name` must be 1-64 lowercase letters, digits and single hyphens, got \"Bad-Name\"",
      "nimbus-docs: skills/alias: skipped symlink",
      "nimbus-docs: skills/empty: skipped, no SKILL.md",
      "nimbus-docs: skills/linked: skipped symlink deploy.sh",
      "nimbus-docs: skills/long: skipped, `description` must be at most 1024 characters",
      "nimbus-docs: skills/mismatch: skipped, `name` \"other\" must match the folder name",
      "nimbus-docs: skills/link-skill: skipped symlink SKILL.md",
      "nimbus-docs: skills/list: skipped, SKILL.md frontmatter is not a YAML mapping",
      "nimbus-docs: skills/no-frontmatter: skipped, SKILL.md has no YAML frontmatter",
      "nimbus-docs: skills/unquoted: skipped, SKILL.md frontmatter is not valid YAML: Nested mappings are not allowed in compact mappings at line 2, column 14",
    ].sort());
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("all-invalid skills produce no index and one summary warning; no skills folder produces nothing", () => {
  const dir = skillsDir((dir) => {
    file(dir, "a/SKILL.md", "no frontmatter");
    file(dir, "b/README.md", "no SKILL.md");
  });
  try {
    const result = publishAgentSkills(dir)!;
    assert.equal(result.index, undefined);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.warnings.length, 3);
    assert.match(result.warnings.at(-1)!, /no Agent Skills index emitted: every folder under skills\/ was skipped \(2 checked/);
    assert.equal(publishAgentSkills(path.join(dir, "missing")), undefined);
    const empty = publishAgentSkills(skillsDir(() => {}))!;
    assert.deepEqual(empty, { artifacts: [], warnings: [] });
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
