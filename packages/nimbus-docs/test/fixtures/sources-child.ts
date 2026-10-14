// A separate process that resolves sources or takes the sources lock, for
// the snapshot-coordination tests. Usage:
//   sources-child.ts hold <root> <sources-json>     resolve, print "ready", wait for stdin to close
//   sources-child.ts resolve <root> <sources-json>  resolve, print the commits, exit
//   sources-child.ts lock <root> <log-file>         take the lock, log enter/exit around 300 ms

import { appendFileSync } from "node:fs";

import { resolveContentSources, withSourcesLock } from "../../src/_internal/content-sources.ts";

const [mode, root, arg] = process.argv.slice(2) as [string, string, string];
const log = (level: string, message: string) => process.stderr.write(`${level}: ${message}\n`);

if (mode === "lock") {
  await withSourcesLock(
    root,
    async () => {
      appendFileSync(arg, `enter ${process.pid} ${Date.now()}\n`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      appendFileSync(arg, `exit ${process.pid} ${Date.now()}\n`);
    },
    log,
  );
} else {
  const { snapshots } = await resolveContentSources(JSON.parse(arg), { projectRoot: root, log });
  process.stdout.write(`${JSON.stringify(Object.fromEntries([...snapshots].map(([name, s]) => [name, s.commit])))}\n`);
  if (mode === "hold") {
    process.stdout.write("ready\n");
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.on("end", resolve));
  }
}
