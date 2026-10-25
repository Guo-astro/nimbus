/**
 * Agent Skills publication: `skills/<name>/` folders in the Agent Skills
 * format become the discovery index at `/.well-known/agent-skills/index.json`
 * plus one artifact per skill, per the Agent Skills Discovery RFC v0.2.0
 * (cloudflare/agent-skills-discovery-rfc at 1bd1167).
 *
 * Pure: reads the folder, returns bytes and warnings. The integration decides
 * where to write them and when to log.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

export const AGENT_SKILLS_SCHEMA =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
export const AGENT_SKILLS_PATH = "/.well-known/agent-skills";
export const AGENT_SKILLS_INDEX_PATH = `${AGENT_SKILLS_PATH}/index.json`;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

export interface AgentSkillEntry {
  name: string;
  type: "skill-md" | "archive";
  description: string;
  url: string;
  digest: string;
}

export interface AgentSkillArtifact {
  /** Origin-root path, for example `/.well-known/agent-skills/deploy/SKILL.md`. */
  pathname: string;
  type: string;
  bytes: Buffer;
}

export interface AgentSkillsPublication {
  /** Present when at least one skill is valid. */
  index?: { $schema: string; skills: AgentSkillEntry[] };
  /** Every file to serve, index included, in origin-root path order. */
  artifacts: AgentSkillArtifact[];
  warnings: string[];
}

interface SkillFile {
  /** Posix path relative to the skill folder. */
  relative: string;
  absolute: string;
  executable: boolean;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Parsed frontmatter, or a string saying why there is none. */
function frontmatter(source: string): Record<string, unknown> | string {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return "SKILL.md has no YAML frontmatter";
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (error) {
    return `SKILL.md frontmatter is not valid YAML: ${(error as Error).message.split("\n")[0]!.replace(/:$/, "")}`;
  }
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : "SKILL.md frontmatter is not a YAML mapping";
}

/** Every regular file under `dir`, skipping dot entries; symlinks are reported. */
function collectFiles(
  dir: string,
  warn: (message: string) => void,
  folder: string,
  relativeDir = "",
): SkillFile[] {
  const files: SkillFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      warn(`skills/${folder}: skipped symlink ${relative}`);
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...collectFiles(absolute, warn, folder, relative));
      continue;
    }
    if (!entry.isFile()) continue;
    const mode = fs.statSync(absolute).mode;
    files.push({ relative, absolute, executable: (mode & 0o111) !== 0 });
  }
  return files.sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

// --- ustar writer ----------------------------------------------------------
// Deterministic by construction: sorted entries, zero uid/gid/mtime, empty
// owner names, and only the executable bit kept from the source mode.

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, "0") + "\0", "ascii");
}

function splitName(relative: string): [string, string] | undefined {
  const bytes = Buffer.byteLength(relative);
  if (bytes <= 100) return ["", relative];
  for (let index = relative.length - 1; index > 0; index--) {
    if (relative[index] !== "/") continue;
    const prefix = relative.slice(0, index);
    const name = relative.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
      return [prefix, name];
  }
  return undefined;
}

function tarHeader(relative: string, size: number, executable: boolean): Buffer | undefined {
  const split = splitName(relative);
  if (!split) return undefined;
  const [prefix, name] = split;
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(executable ? 0o755 : 0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156); // checksum placeholder
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
  return header;
}

function tarGz(files: readonly { relative: string; bytes: Buffer; executable: boolean }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = tarHeader(file.relative, file.bytes.length, file.executable);
    if (!header) continue;
    blocks.push(header, file.bytes);
    const padding = (512 - (file.bytes.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// --- publication -----------------------------------------------------------

/** YAML reads `2024` or `true` as scalars; the spec treats them as text. */
function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function validate(
  folder: string,
  data: Record<string, unknown> | string,
): { name: string; description: string } | string {
  if (typeof data === "string") return data;
  const name = scalar(data.name);
  const description = scalar(data.description);
  if (data.name === undefined || data.name === null) return "frontmatter is missing `name`";
  if (name === undefined) return "`name` must be a string";
  if (!name) return "frontmatter is missing `name`";
  if ([...name].length > NAME_MAX || !NAME_PATTERN.test(name))
    return `\`name\` must be 1-64 lowercase letters, digits and single hyphens, got ${JSON.stringify(name)}`;
  if (name !== folder) return `\`name\` ${JSON.stringify(name)} must match the folder name`;
  if (data.description === undefined || data.description === null)
    return "frontmatter is missing `description`";
  if (description === undefined) return "`description` must be a string";
  if (!description.trim()) return "frontmatter is missing `description`";
  if ([...description].length > DESCRIPTION_MAX)
    return `\`description\` must be at most ${DESCRIPTION_MAX} characters`;
  return { name, description };
}

/** Returns `undefined` when there is no `skills/` folder at all. */
export function publishAgentSkills(skillsDir: string): AgentSkillsPublication | undefined {
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) return undefined;
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(`nimbus-docs: ${message}`);
  const skills: AgentSkillEntry[] = [];
  const artifacts: AgentSkillArtifact[] = [];
  let candidates = 0;
  const folders = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of folders) {
    if (entry.isSymbolicLink()) {
      warn(`skills/${entry.name}: skipped symlink`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    candidates++;
    const folder = entry.name;
    const dir = path.join(skillsDir, folder);
    const skillPath = path.join(dir, "SKILL.md");
    const skillStat = fs.existsSync(skillPath) ? fs.lstatSync(skillPath) : undefined;
    if (skillStat?.isSymbolicLink()) {
      warn(`skills/${folder}: skipped symlink SKILL.md`);
      continue;
    }
    if (!skillStat?.isFile()) {
      warn(`skills/${folder}: skipped, no SKILL.md`);
      continue;
    }
    const source = fs.readFileSync(skillPath);
    const valid = validate(folder, frontmatter(source.toString("utf8")));
    if (typeof valid === "string") {
      warn(`skills/${folder}: skipped, ${valid}`);
      continue;
    }
    const files = collectFiles(dir, warn, folder);
    let artifact: AgentSkillArtifact;
    if (files.length === 1) {
      artifact = {
        pathname: `${AGENT_SKILLS_PATH}/${folder}/SKILL.md`,
        type: "text/markdown; charset=utf-8",
        bytes: source,
      };
    } else {
      const tooLong = files.filter((file) => !splitName(file.relative));
      for (const file of tooLong)
        warn(`skills/${folder}: skipped ${file.relative}, path too long for a tar entry`);
      artifact = {
        pathname: `${AGENT_SKILLS_PATH}/${folder}.tar.gz`,
        type: "application/gzip",
        bytes: tarGz(
          files.map((file) => ({
            relative: file.relative,
            bytes: fs.readFileSync(file.absolute),
            executable: file.executable,
          })),
        ),
      };
    }
    skills.push({
      name: valid.name,
      type: files.length === 1 ? "skill-md" : "archive",
      description: valid.description,
      url: artifact.pathname,
      digest: sha256(artifact.bytes),
    });
    artifacts.push(artifact);
  }
  if (skills.length === 0) {
    if (candidates > 0)
      warn(
        `no Agent Skills index emitted: every folder under skills/ was skipped (${candidates} checked, see the warnings above)`,
      );
    return { artifacts: [], warnings };
  }
  const index = { $schema: AGENT_SKILLS_SCHEMA, skills };
  artifacts.unshift({
    pathname: AGENT_SKILLS_INDEX_PATH,
    type: "application/json",
    bytes: Buffer.from(JSON.stringify(index, null, 2) + "\n"),
  });
  return { index, artifacts, warnings };
}
