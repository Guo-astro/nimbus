// Prints the test files for one CI shard, one per line. Run from this package:
//   node scripts/shard-files.mjs 2/4
// Files with an entry in test/shard-costs.json (whole seconds, rounded up so
// every file costs at least its process start) are placed greedily, heaviest
// first onto the lightest shard; the rest are dealt round-robin, so a new file
// always lands somewhere. Refresh the costs from a lane's downloaded reports:
//   node scripts/shard-files.mjs --write-costs <reports-dir>
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COSTS = "test/shard-costs.json";

export function inventory(cwd = process.cwd()) {
  const files = execFileSync("git", ["ls-files", "test/*.test.ts"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean).sort();
  if (files.length === 0) throw new Error(`no test files under ${path.join(cwd, "test")}`);
  return files;
}

export function readCosts(cwd = process.cwd()) {
  const file = path.join(cwd, COSTS);
  const costs = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const [name, seconds] of Object.entries(costs)) {
    if (!Number.isFinite(seconds)) throw new Error(`${COSTS}: ${name} has cost ${JSON.stringify(seconds)}, expected seconds`);
  }
  return costs;
}

export function assign(files, costs, shards) {
  const bins = Array.from({ length: shards }, () => ({ files: [], total: 0 }));
  const costed = files.filter((file) => file in costs).sort((a, b) => costs[b] - costs[a] || (a < b ? -1 : 1));
  for (const file of costed) {
    const bin = bins.reduce((lightest, bin) => (bin.total < lightest.total || (bin.total === lightest.total && bin.files.length < lightest.files.length) ? bin : lightest));
    bin.files.push(file);
    bin.total += costs[file];
  }
  files.filter((file) => !(file in costs)).forEach((file, i) => bins[i % shards].files.push(file));
  return bins.map((bin) => bin.files.sort());
}

export function writeCosts(reportsDir, cwd = process.cwd()) {
  const costs = {};
  for (const name of readdirSync(reportsDir).filter((name) => /^report-\d+\.ndjson$/.test(name)).sort()) {
    for (const line of readFileSync(path.join(reportsDir, name), "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.file) costs[row.file] = Math.ceil(row.durationMs / 1000);
    }
  }
  const sorted = Object.fromEntries(Object.keys(costs).sort().map((file) => [file, costs[file]]));
  writeFileSync(path.join(cwd, COSTS), `${JSON.stringify(sorted, null, 2)}\n`);
  return Object.keys(sorted).length;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [arg, reportsDir] = process.argv.slice(2);
  if (arg === "--write-costs" && reportsDir) {
    console.log(`wrote ${writeCosts(reportsDir)} file costs to ${COSTS}`);
  } else {
    const match = /^(\d+)\/(\d+)$/.exec(arg ?? "");
    const [index, shards] = match ? match.slice(1).map(Number) : [];
    if (!match || index < 1 || index > shards) {
      console.error("usage: node scripts/shard-files.mjs <i>/<n> | --write-costs <reports-dir>");
      process.exit(2);
    }
    const files = assign(inventory(), readCosts(), shards)[index - 1];
    if (files.length === 0) throw new Error(`shard ${arg} has no files`);
    process.stdout.write(`${files.join("\n")}\n`);
  }
}
