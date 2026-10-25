// A node --test reporter that writes one JSON line per test file, taken from
// the runner's own per-file `test:summary` event, so a report shows what ran.
// In CI the first line stamps the run and shard from the environment.
import path from "node:path";

export default async function* (source) {
  const { GITHUB_SHA: sha, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt, TEST_SHARD: shard } = process.env;
  if (sha) yield `${JSON.stringify({ run: { sha, runId, runAttempt, shard } })}\n`;
  for await (const event of source) {
    if (event.type !== "test:summary" || !event.data.file) continue;
    const { file, success, counts, duration_ms } = event.data;
    const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
    yield `${JSON.stringify({ file: relative, success, counts, durationMs: Math.round(duration_ms) })}\n`;
  }
}
