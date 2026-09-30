import assert from "node:assert/strict";
import { test } from "node:test";

import { humanInstructions } from "../src/cli/feature.js";
import { progress } from "../src/cli/progress.js";

function captureStdout(run: () => void): string {
  const write = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

test("progress prints plain lines without a terminal", () => {
  const out = captureStdout(() => {
    const spinner = progress(false);
    spinner.start("Resolving dependencies");
    spinner.stop("Resolved 2 items.");
  });
  assert.doesNotMatch(out, /\x1b/);
  assert.equal(out.match(/Resolving dependencies/g)?.length, 1);
  assert.equal(out.match(/Resolved 2 items\./g)?.length, 1);
});

test("feature instructions separate every block with one blank line", () => {
  const text = humanInstructions("npx @cloudflare/nimbus-docs add copy-prompt");
  assert.doesNotMatch(text, /\n\n\n/);
  assert.match(text, /--print \| pi\n\nOr paste this prompt/);
});
