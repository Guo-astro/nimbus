// `nimbus-docs add source <name|url>` end to end, against the generated
// registry served locally: listing, aliases, the URL guide, the Notion
// guide (printed, nothing written), and the errors.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { sourceRegistry } from "./fixtures/source-registry.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const REGISTRY = sourceRegistry();
const served = (file: string) => readFileSync(path.join(REGISTRY, file), "utf8");
// What the CLI prints of a guide: everything from its first heading, no JSON frontmatter.
const guide = (file: string) => served(file).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");

let server: http.Server;
let origin = "";
const requests: string[] = [];

before(async () => {
  server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    const file = path.join(REGISTRY, decodeURIComponent((request.url ?? "/").replace(/^\/+/, "")));
    if (!file.startsWith(REGISTRY) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": file.endsWith(".json") ? "application/json" : "text/markdown" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.close();
  rmSync(REGISTRY, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(path.join(TEST_TMP, "nimbus-add-source-"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "site", type: "module" }),
  );
  mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

// Without the variables coding agents set, so the CLI sees a person unless
// `--print` says otherwise.
const AGENT_ENV = /^(AI_AGENT|CLAUDECODE|CLAUDE_CODE.*|CODEX.*|CURSOR.*|OPENCODE.*|GEMINI_CLI|REPL_ID|AUGMENT.*|AMP_.*)$/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !AGENT_ENV.test(key)));

function run(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string; all: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd,
      env: { ...baseEnv, NIMBUS_REGISTRY_URL: origin, NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr, all: stdout + stderr }));
  });
}

test("add source alone lists the sources, as list --type source does", async () => {
  const dir = project();
  try {
    const bare = await run(dir, "add", "source");
    const listed = await run(dir, "list", "--type", "source");
    assert.equal(bare.code, 0);
    assert.equal(bare.stdout, listed.stdout);
    assert.match(bare.stdout, /Sources\n\s+git \(github, gitlab, bitbucket\)\s+Pages from another git repository/);
    assert.match(bare.stdout, /\n\s+notion\s+Pages from a Notion database/);
    assert.match(bare.stdout, /\n\s+<url>\s+Any other provider/);
    assert.match(bare.stdout, /Sources:\s+.*add source <name\|url>/);
    assert.doesNotMatch(bare.stdout, /Components|Features/);
    const all = await run(dir, "list");
    assert.match(all.stdout, /Components[\s\S]*Features[\s\S]*Sources/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git prints its guide; an alias prints the same guide under its Host line", async () => {
  const dir = project();
  try {
    const git = await run(dir, "add", "source", "git", "--print");
    assert.equal(git.code, 0, git.stderr);
    assert.equal(git.stdout, guide("sources/git.md"));
    for (const [alias, host] of [["github", "GitHub"], ["gitlab", "GitLab"], ["bitbucket", "Bitbucket"]]) {
      const result = await run(dir, "add", "source", alias!, "--print");
      assert.equal(result.stdout, `Host: ${host}\n\n${guide("sources/git.md")}`, alias);
    }
    // Without --print or an agent, the human gets the pipe commands on stderr.
    const human = await run(dir, "add", "source", "github");
    assert.equal(human.stdout, "");
    assert.match(human.stderr, /add source github --print \| claude/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a URL gets the generic guide under a Research start line and is never requested", async () => {
  const dir = project();
  try {
    const url = "https://developers.example-cms.test/docs/content-api";
    requests.length = 0;
    const result = await run(dir, "add", "source", url, "--print");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `Research start: ${url}\n\n${guide("sources/from-url.md")}`);
    assert.deepEqual(requests, ["/sources/from-url.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notion prints its guide and writes nothing: the agent writes the loader from it", async () => {
  const dir = project();
  try {
    const result = await run(dir, "add", "source", "notion", "--print");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, guide("sources/notion.md"), "stdout is the guide, byte for byte");
    assert.match(result.stdout, /^# Add a Notion database/, "no frontmatter");
    assert.match(result.stdout, /notion-to-md/);
    assert.deepEqual(readdirSync(path.join(dir, "src")), [], "nothing written");
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")), { name: "site", type: "module" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown names, extra positionals, wrong flags and a source without its kind are errors", async () => {
  const dir = project();
  try {
    const unknown = await run(dir, "add", "source", "confluence");
    assert.equal(unknown.code, 1);
    assert.match(unknown.all, /Unknown source: `confluence`\. Sources: git, github, gitlab, bitbucket, notion, or an https:\/\/ URL/);
    assert.match(unknown.all, /Any other git host: `add source git`/);
    const extra = await run(dir, "add", "source", "github", "extra");
    assert.equal(extra.code, 1);
    assert.match(extra.all, /takes one name or URL/);
    const adapter = await run(dir, "add", "source", "github", "--adapter", "node");
    assert.equal(adapter.code, 1);
    assert.match(adapter.all, /`--adapter` doesn't apply to `add source`/);
    const overwrite = await run(dir, "add", "source", "notion", "--overwrite");
    assert.equal(overwrite.code, 1);
    assert.match(overwrite.all, /`--overwrite` doesn't apply to `add source`: it prints a guide and writes no files/);
    for (const name of ["notion", "github"]) {
      const bare = await run(dir, "add", name);
      assert.equal(bare.code, 1);
      assert.match(bare.all, new RegExp(`Did you mean \`.*add source ${name}\`\\?`));
    }
    // Among several slugs too, before anything is installed.
    const mixed = await run(dir, "add", "card", "github");
    assert.equal(mixed.code, 1);
    assert.match(mixed.all, /Did you mean `.*add source github`\?/);
    assert.ok(!existsSync(path.join(dir, "src/components/ui/card")), "nothing installed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the help shows the add source grammar", async () => {
  const dir = project();
  try {
    const help = await run(dir, "--help");
    assert.match(help.stdout + help.stderr, /add source <name\|url>/);
    assert.match(help.stdout + help.stderr, /--type <ui\|lib\|feature\|source>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
