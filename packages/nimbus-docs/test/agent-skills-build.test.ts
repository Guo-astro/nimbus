import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { build, dev } from "astro";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";

const skills = {
  "git-workflow/SKILL.md":
    "---\nname: git-workflow\ndescription: Follow team Git conventions.\n---\n# Git\n",
  "deploy/SKILL.md": "---\nname: deploy\ndescription: Deploy with Wrangler.\n---\nSee scripts/deploy.sh\n",
  "deploy/scripts/deploy.sh": "#!/bin/sh\nwrangler deploy\n",
  "broken/SKILL.md": "no frontmatter\n",
};
const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("a real build publishes skills at the origin root with headers and an ARD entry, warning about the broken one", async () => {
  const site = await fixture(undefined, "docs", false, skills);
  // Astro's logger writes to the process streams, not console.warn.
  const output: string[] = [];
  const streams = [process.stdout, process.stderr].map((stream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof stream.write;
    return () => {
      stream.write = original;
    };
  });
  try {
    await build({ ...site.config, logLevel: "warn" });
    const index = JSON.parse(await site.read("dist/.well-known/agent-skills/index.json"));
    assert.deepEqual(
      index.skills.map((skill: { name: string; type: string; url: string }) => [skill.name, skill.type, skill.url]),
      [
        ["deploy", "archive", "/.well-known/agent-skills/deploy.tar.gz"],
        ["git-workflow", "skill-md", "/.well-known/agent-skills/git-workflow/SKILL.md"],
      ],
    );
    for (const skill of index.skills)
      assert.equal(skill.digest, sha256(await site.readBytes(`dist${skill.url}`)));
    const ard = JSON.parse(await site.read("dist/.well-known/ard.json"));
    assert.ok(
      ard.entries.some(
        (entry: { url: string; type: string }) =>
          entry.url === "https://example.test/.well-known/agent-skills/index.json" &&
          entry.type === "application/json",
      ),
    );
    const headers = await site.read("dist/_headers");
    assert.match(headers, /^\/\.well-known\/agent-skills\/\*\n  Access-Control-Allow-Origin: \*/m);
    assert.match(headers, /^\/\.well-known\/agent-skills\/\*\.tar\.gz\n  Content-Type: application\/gzip/m);
    assert.match(output.join(""), /skills\/broken: skipped, SKILL.md has no YAML frontmatter/);
  } finally {
    for (const restore of streams) restore();
    await rm(site.root, { recursive: true, force: true });
  }
});

test("without a skills folder nothing is published and ARD has no skills entry", async () => {
  const site = await fixture();
  try {
    await build(site.config);
    await assert.rejects(site.read("dist/.well-known/agent-skills/index.json"));
    assert.doesNotMatch(await site.read("dist/.well-known/ard.json"), /agent-skills/);
    assert.doesNotMatch(await site.read("dist/_headers"), /agent-skills/);
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("owner files under the skills prefix fail the build only when a skills folder exists", async () => {
  const site = await fixture(undefined, "docs", false, skills);
  try {
    await site.write("public/.well-known/agent-skills/index.json", "{}");
    await assert.rejects(build(site.config), /Move your existing file at public[/\\]\.well-known[/\\]agent-skills[/\\]index\.json/);
    await rm(path.join(site.root, "public/.well-known/agent-skills/index.json"));
    await site.write("public/.well-known/agent-skills/deploy.tar.gz", "stale");
    await assert.rejects(build(site.config), /Move your existing file at public[/\\]\.well-known[/\\]agent-skills[/\\]deploy\.tar\.gz/);
    await rm(path.join(site.root, "skills"), { recursive: true });
    await build(site.config);
    assert.equal(await site.read("dist/.well-known/agent-skills/deploy.tar.gz"), "stale");
  } finally {
    await rm(site.root, { recursive: true, force: true });
  }
});

test("the dev server leaves owner files under the skills prefix to Astro when it publishes nothing", async () => {
  const site = await fixture();
  await site.write("public/.well-known/agent-skills/index.json", '{"skills":[]}');
  const server = await dev({ ...site.config, server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    // Astro's dev server serves public/ under the base; Nimbus must not swallow it.
    const owner = await fetch(`${origin}/docs/.well-known/agent-skills/index.json`);
    assert.equal(owner.status, 200, await owner.clone().text());
    assert.equal(await owner.text(), '{"skills":[]}');
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("the dev server serves the index and artifacts at the origin root with GET and HEAD", async () => {
  const site = await fixture(undefined, "docs", false, skills);
  const server = await dev({ ...site.config, server: { host: "127.0.0.1", port: 0 } });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const index = await fetch(`${origin}/.well-known/agent-skills/index.json`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("Content-Type"), "application/json");
    assert.equal(index.headers.get("Access-Control-Allow-Origin"), "*");
    const body = await index.json();
    for (const skill of body.skills) {
      const head = await fetch(origin + skill.url, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      const artifact = await fetch(origin + skill.url);
      assert.equal(artifact.status, 200);
      assert.match(
        artifact.headers.get("Content-Type") ?? "",
        skill.type === "archive" ? /application\/gzip/ : /text\/markdown/,
      );
      assert.equal(skill.digest, sha256(Buffer.from(await artifact.arrayBuffer())));
    }
    assert.equal((await fetch(`${origin}/.well-known/agent-skills/nope/SKILL.md`)).status, 404);
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});
