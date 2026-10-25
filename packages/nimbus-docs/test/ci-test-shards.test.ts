import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const FILES = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/e.test.ts", "test/sub/f.test.ts"];

function repo(files = FILES, costs?: Record<string, number>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-shards-"));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "");
  }
  if (costs) fs.writeFileSync(path.join(dir, "test/shard-costs.json"), JSON.stringify(costs));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function run(script: string, args: string[], cwd: string, env = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

function shards(cwd: string, count = 4) {
  return Array.from({ length: count }, (_, i) => run("shard-files.mjs", [`${i + 1}/${count}`], cwd).out.split("\n").filter(Boolean));
}

type Row = { file: string; durationMs?: number };
const RUN = { sha: "abc123", runId: "77", runAttempt: "1" };

function report(dir: string, shard: number, files: (string | Row)[], stamp: Record<string, string> | null = { ...RUN, shard: `${shard}/4` }) {
  const rows = files.map((row) => (typeof row === "string" ? { file: row, success: true, counts: { tests: 1 }, durationMs: 1000 } : { success: true, counts: { tests: 1 }, durationMs: 1000, ...row }));
  const lines = [...(stamp ? [JSON.stringify({ run: stamp })] : []), ...rows.map((row) => JSON.stringify(row))];
  fs.writeFileSync(path.join(dir, `report-${shard}.ndjson`), `${lines.join("\n")}\n`);
}

function check(cwd: string, reports: string, args: string[] = ["--sha", RUN.sha, "--run-id", RUN.runId]) {
  return run("check-test-reports.mjs", ["--reports", reports, "--shards", "4", ...args], cwd);
}

function problems(cwd: string, reports: string) {
  const result = check(cwd, reports);
  assert.equal(result.status, 1, result.out + result.err);
  return result.err.trim().split("\n");
}

test("shard-files deals every file out exactly once, round-robin over the sorted list without costs", () => {
  const cwd = repo();
  try {
    const got = shards(cwd);
    assert.deepEqual(got, [["test/a.test.ts", "test/e.test.ts"], ["test/b.test.ts", "test/sub/f.test.ts"], ["test/c.test.ts"], ["test/d.test.ts"]]);
    assert.deepEqual(got.flat().sort(), FILES);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("shard-files places costed files heaviest-first, still runs an uncosted file, and ignores a costed file that is gone", () => {
  const cwd = repo(FILES, { "test/a.test.ts": 90, "test/b.test.ts": 60, "test/c.test.ts": 50, "test/d.test.ts": 40, "test/gone.test.ts": 500 });
  try {
    const got = shards(cwd);
    assert.deepEqual(got.map((shard) => shard[0]), ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"]);
    assert.deepEqual(got.flat().sort(), FILES);
    assert.ok(got.flat().includes("test/e.test.ts"));
    assert.ok(!got.flat().includes("test/gone.test.ts"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("shard-files rejects a shard outside the range and an empty inventory", () => {
  const cwd = repo();
  const empty = repo([]);
  try {
    assert.equal(run("shard-files.mjs", ["5/4"], cwd).status, 2);
    assert.equal(run("shard-files.mjs", ["one"], cwd).status, 2);
    const result = run("shard-files.mjs", ["1/4"], empty);
    assert.notEqual(result.status, 0);
    assert.match(result.err, /no test files/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the reporter writes a run stamp and one line per file, which refresh the costs", () => {
  const cwd = repo([]);
  try {
    fs.mkdirSync(path.join(cwd, "test"));
    for (const name of ["one", "two"]) fs.writeFileSync(path.join(cwd, "test", `${name}.test.mjs`), 'import { test } from "node:test";\ntest("t", () => {});\n');
    const reports = path.join(cwd, "reports");
    fs.mkdirSync(reports);
    const result = spawnSync(process.execPath, ["--test", "--test-reporter", path.join(SCRIPTS, "test-file-summary-reporter.mjs"), "--test-reporter-destination", path.join(reports, "report-1.ndjson"), "test/one.test.mjs", "test/two.test.mjs"], {
      cwd, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, GITHUB_SHA: "abc123", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "2", TEST_SHARD: "1/4" },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = fs.readFileSync(path.join(reports, "report-1.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines[0], { run: { sha: "abc123", runId: "77", runAttempt: "2", shard: "1/4" } });
    assert.deepEqual(lines.slice(1).map((row) => [row.file, row.success, row.counts.tests]).sort(), [["test/one.test.mjs", true, 1], ["test/two.test.mjs", true, 1]]);
    const refresh = run("shard-files.mjs", ["--write-costs", reports], cwd);
    assert.equal(refresh.status, 0, refresh.err);
    const costs = JSON.parse(fs.readFileSync(path.join(cwd, "test/shard-costs.json"), "utf8"));
    assert.deepEqual(Object.keys(costs), ["test/one.test.mjs", "test/two.test.mjs"]);
    assert.ok(Object.values(costs).every((seconds) => seconds === 1));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("check-test-reports accepts a complete lane and summarises the balance", () => {
  const cwd = repo();
  const reports = path.join(cwd, "reports");
  fs.mkdirSync(reports);
  try {
    report(reports, 1, [{ file: "test/a.test.ts", durationMs: 3000 }, "test/e.test.ts"]);
    report(reports, 2, ["test/b.test.ts", "test/sub/f.test.ts"]);
    report(reports, 3, ["test/c.test.ts"]);
    report(reports, 4, ["test/d.test.ts"]);
    const result = check(cwd, reports);
    assert.equal(result.status, 0, result.err);
    assert.equal(result.out, "ok: 6 test files across 4 shards\nshard 1/4: 4 s of test files\nshard 2/4: 2 s of test files\nshard 3/4: 1 s of test files\nshard 4/4: 1 s of test files\nheaviest shard 2.00x the mean\n");
    assert.equal(check(cwd, reports, []).status, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("check-test-reports names a file that ran on no shard, on two shards, or that isn't in the checkout", () => {
  const cwd = repo();
  const reports = path.join(cwd, "reports");
  fs.mkdirSync(reports);
  try {
    report(reports, 1, ["test/a.test.ts", "test/b.test.ts"]);
    report(reports, 2, ["test/b.test.ts", "test/sub/f.test.ts"]);
    report(reports, 3, ["test/c.test.ts", "test/zz.test.ts"]);
    report(reports, 4, ["test/d.test.ts"]);
    assert.deepEqual(problems(cwd, reports), ["test/b.test.ts: ran on shards 1/4 and 2/4", "test/e.test.ts: ran on no shard", "test/zz.test.ts: ran on shard 3/4 but is not in the checkout"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("check-test-reports names an empty shard, a missing report, and a malformed report", () => {
  const cwd = repo();
  const reports = path.join(cwd, "reports");
  fs.mkdirSync(reports);
  try {
    report(reports, 1, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/e.test.ts", "test/sub/f.test.ts"]);
    report(reports, 2, []);
    fs.writeFileSync(path.join(reports, "report-4.ndjson"), "{not json\n");
    assert.deepEqual(problems(cwd, reports), ["shard 2/4: ran no test files", "shard 3/4: no report uploaded", "shard 4/4: malformed report (Expected property name or '}' in JSON at position 1 (line 1 column 2))"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("check-test-reports rejects a report from another run, for another shard, or without a stamp", () => {
  const cwd = repo();
  const reports = path.join(cwd, "reports");
  fs.mkdirSync(reports);
  try {
    report(reports, 1, ["test/a.test.ts", "test/e.test.ts"], { ...RUN, sha: "000000", shard: "1/4" });
    report(reports, 2, ["test/b.test.ts", "test/sub/f.test.ts"], { ...RUN, runId: "76", shard: "2/4" });
    report(reports, 3, ["test/c.test.ts"], { ...RUN, shard: "4/4" });
    report(reports, 4, ["test/d.test.ts"], null);
    assert.deepEqual(problems(cwd, reports), ["shard 1/4: report is from another run (000000 run 77)", "shard 2/4: report is from another run (abc123 run 76)", "shard 3/4: report is for shard 4/4", "shard 4/4: report has no run stamp"]);
    assert.equal(check(cwd, reports, []).status, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
