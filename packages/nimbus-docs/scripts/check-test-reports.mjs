// Checks one CI lane's shard reports against the checkout: every test file ran
// on exactly one shard, every shard ran something, and every report is this
// run's. Run from this package:
//   node scripts/check-test-reports.mjs --reports <dir> --shards 4 [--sha <sha> --run-id <id>]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { inventory } from "./shard-files.mjs";

function check(files, reportsDir, { shards, sha, runId }) {
  const problems = [];
  const ranOn = new Map();
  const totals = [];
  for (let index = 1; index <= shards; index++) {
    const shard = `${index}/${shards}`;
    const file = path.join(reportsDir, `report-${index}.ndjson`);
    if (!existsSync(file)) {
      problems.push(`shard ${shard}: no report uploaded`);
      continue;
    }
    let rows;
    try {
      rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      problems.push(`shard ${shard}: malformed report (${error.message})`);
      continue;
    }
    const stamp = rows.find((row) => row.run)?.run;
    if (sha && !stamp) problems.push(`shard ${shard}: report has no run stamp`);
    else if (sha && (stamp.sha !== sha || stamp.runId !== runId)) problems.push(`shard ${shard}: report is from another run (${stamp.sha} run ${stamp.runId})`);
    else if (stamp && stamp.shard !== shard) problems.push(`shard ${shard}: report is for shard ${stamp.shard}`);
    const ran = rows.filter((row) => row.file);
    if (ran.length === 0) problems.push(`shard ${shard}: ran no test files`);
    totals.push(ran.reduce((sum, row) => sum + row.durationMs, 0) / 1000);
    for (const row of ran) ranOn.set(row.file, [...(ranOn.get(row.file) ?? []), shard]);
  }
  const expected = new Set(files);
  for (const [file, on] of ranOn) {
    if (!expected.has(file)) problems.push(`${file}: ran on shard ${on[0]} but is not in the checkout`);
    else if (on.length > 1) problems.push(`${file}: ran on shards ${on.join(" and ")}`);
  }
  for (const file of files) if (!ranOn.has(file)) problems.push(`${file}: ran on no shard`);
  return { problems: problems.sort(), totals };
}

function summarize(files, shards, totals) {
  const mean = totals.reduce((sum, total) => sum + total, 0) / totals.length;
  return [
    `ok: ${files.length} test files across ${shards} shards`,
    ...totals.map((total, i) => `shard ${i + 1}/${shards}: ${Math.round(total)} s of test files`),
    `heaviest shard ${(Math.max(...totals) / mean).toFixed(2)}x the mean`,
  ].join("\n");
}

const { values } = parseArgs({ options: { reports: { type: "string" }, shards: { type: "string" }, sha: { type: "string" }, "run-id": { type: "string" } } });
const shards = Number(values.shards);
if (!values.reports || !(shards >= 1) || Boolean(values.sha) !== Boolean(values["run-id"])) {
  console.error("usage: node scripts/check-test-reports.mjs --reports <dir> --shards <n> [--sha <sha> --run-id <id>]");
  process.exit(2);
}
const files = inventory();
const { problems, totals } = check(files, values.reports, { shards, sha: values.sha, runId: values["run-id"] });
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(summarize(files, shards, totals));
