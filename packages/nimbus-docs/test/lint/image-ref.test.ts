/**
 * Tests for `nimbus/image-ref`.
 *
 * The rule's truth is the filesystem — each test stages a tmpdir project
 * root (inferred from the parsed file's absolute path, `<root>/src/...`),
 * writes image files under `public/` / `src/assets/` / next to the page,
 * and asserts the diagnostics.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { lintFile } from "../../src/lint/engine.js";
import { applyFixes } from "../../src/lint/fix.js";
import { parseSource } from "../../src/lint/parse.js";

interface Setup {
  root: string;
  pagePath: string;
}

function setupProject(files: string[] = []): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-ir-"));
  fs.mkdirSync(path.join(root, "src/content/docs"), { recursive: true });
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }
  return { root, pagePath: path.join(root, "src/content/docs/page.mdx") };
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

const FM = `---
title: Test
description: A description for the test page.
---
`;

function lint(setup: Setup, mdx: string, options?: Record<string, unknown>) {
  const parsed = parseSource(mdx, {
    path: "src/content/docs/page.mdx",
    absPath: setup.pagePath,
    collection: "docs",
  });
  return lintFile(parsed, {
    rules: {
      "nimbus/image-ref": options ? ["error", options] : "error",
    },
  }).filter((d) => d.code === "nimbus/image-ref");
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

test("image-ref is silent on resolvable refs", () => {
  const setup = setupProject([
    "public/images/d1/concept.png",
    "src/content/docs/local.png",
  ]);
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

![Concept](/images/d1/concept.png)
![Local](./local.png)
<img src="/images/d1/concept.png" alt="again" />
`,
    );
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref skips external, data, and dynamic refs", () => {
  const setup = setupProject();
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

![Remote](https://example.com/x.png)
![Proto-relative](//example.com/x.png)
![Data](data:image/png;base64,AAAA)
<img src={imageUrl} alt="dynamic" />
`,
    );
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// Broken
// ---------------------------------------------------------------------------

test("image-ref flags a missing site-absolute image", () => {
  const setup = setupProject();
  try {
    const diags = lint(setup, `${FM}\n![Gone](/images/d1/gone.png)\n`);
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /missing image "\/images\/d1\/gone\.png"/);
    assert.match(diags[0]!.message, /public\/images\/d1\/gone\.png/);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref flags a missing relative image", () => {
  const setup = setupProject();
  try {
    const diags = lint(setup, `${FM}\n![Gone](./shot.png)\n`);
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /missing image "\.\/shot\.png"/);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref flags missing <img src> and reference-style images", () => {
  const setup = setupProject();
  try {
    const diags = lint(
      setup,
      `${FM}
<img src="/missing.png" alt="x" />

![Ref][shot]

[shot]: /also-missing.png
`,
    );
    assert.equal(diags.length, 2);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref suggests a sibling near-match", () => {
  const setup = setupProject(["public/images/concept.png"]);
  try {
    const diags = lint(setup, `${FM}\n![X](/images/concpt.png)\n`);
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /did you mean "concept\.png"/);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test("image-ref resolves configured alias prefixes", () => {
  const setup = setupProject(["src/assets/logo.svg"]);
  try {
    const options = { aliases: { "~/assets/": "src/assets/" } };
    const clean = lint(setup, `${FM}\n![Logo](~/assets/logo.svg)\n`, options);
    assert.deepEqual(clean, []);

    const broken = lint(setup, `${FM}\n![Logo](~/assets/nope.svg)\n`, options);
    assert.equal(broken.length, 1);
    assert.match(broken[0]!.message, /src\/assets\/nope\.svg/);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref honors ignore globs", () => {
  const setup = setupProject();
  try {
    const diags = lint(setup, `${FM}\n![Gen](/images/generated/chart.png)\n`, {
      ignore: ["/images/generated/**"],
    });
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref ignore supports a leading any-depth wildcard and brace expansion", () => {
  const setup = setupProject();
  try {
    const clean = lint(
      setup,
      `${FM}
![thumb](/products/workers/thumbnail.webp)
![thumb2](/products/r2/thumbnail2.webp)
`,
      { ignore: ["**/thumbnail.webp", "**/thumbnail2.webp"] },
    );
    assert.deepEqual(clean, []);

    const broken = lint(setup, `${FM}\n![missing](/other/missing.png)\n`, {
      ignore: ["**/thumbnail.webp", "**/thumbnail2.webp"],
    });
    assert.equal(broken.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref ignore tolerates a stray empty-string pattern (no rule-wide crash)", () => {
  const setup = setupProject();
  try {
    const broken = lint(setup, `${FM}\n![missing](/other/missing.png)\n`, {
      ignore: ["**/thumbnail.webp", ""],
    });
    assert.equal(broken.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref checks opt-in components", () => {
  const setup = setupProject(["public/frames/ok.png"]);
  try {
    const options = { components: [{ name: "Frame", attr: "src" }] };
    const clean = lint(
      setup,
      `${FM}\n<Frame src="/frames/ok.png" />\n`,
      options,
    );
    assert.deepEqual(clean, []);

    const broken = lint(
      setup,
      `${FM}\n<Frame src="/frames/missing.png" />\n`,
      options,
    );
    assert.equal(broken.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref ignores unrecognised url shapes", () => {
  const setup = setupProject();
  try {
    // `~/assets/` without a configured alias is unrecognised — silent.
    const diags = lint(setup, `${FM}\n![X](~/assets/logo.svg)\n`);
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// Under a deployment base
// ---------------------------------------------------------------------------

function lintBased(setup: Setup, mdx: string, options?: Record<string, unknown>) {
  const parsed = parseSource(mdx, {
    path: "src/content/docs/page.mdx",
    absPath: setup.pagePath,
    collection: "docs",
  });
  return lintFile(parsed, {
    base: "/docs",
    rules: { "nimbus/image-ref": options ? ["error", options] : "error" },
  }).filter((d) => d.code === "nimbus/image-ref");
}

function fixed(setup: Setup, mdx: string): string {
  return applyFixes(mdx, lintBased(setup, mdx)).output;
}

test("image-ref under a base: inline images need the base written", () => {
  const setup = setupProject(["public/arch.png"]);
  try {
    const diags = lintBased(
      setup,
      `${FM}
![Written](/docs/arch.png)

![Skips](/arch.png)

![Gone](/gone.png)

![Missing based](/docs/gone.png)

![Not based](/docsite.png)

<img src="/arch.png" alt="jsx" />
`,
    );
    const messages = diags.map((d) => d.message);
    assert.equal(diags.length, 5, messages.join("\n"));
    assert.match(messages[0]!, /^image "\/arch\.png" skips the site base "\/docs" and won't load\. Write "\/docs\/arch\.png"\.$/);
    assert.ok(diags[0]!.fix?.edits.length, "inline image gets a fix");
    assert.match(messages[1]!, /missing image "\/gone\.png" — expected at public\/gone\.png\. Under the site base "\/docs", write "\/docs\/gone\.png" once it exists\./);
    assert.equal(diags[1]!.fix, undefined);
    assert.match(messages[2]!, /missing image "\/docs\/gone\.png" — expected at public\/gone\.png\./);
    assert.match(messages[3]!, /missing image "\/docsite\.png" — expected at public\/docsite\.png\./);
    assert.match(messages[4]!, /^image "\/arch\.png" skips the site base/);
    assert.equal(diags[4]!.fix, undefined, "no fix for <img src>");
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref under a base: definitions must not repeat it, reported once", () => {
  const setup = setupProject(["public/arch.png", "public/docs/kept.png"]);
  try {
    const mdx = `${FM}
![One][arch] and ![Two][arch]

![Plain][plain] ![Kept][kept] [link][linked]

[arch]: /docs/arch.png
[plain]: /arch.png
[kept]: /docs/kept.png
[linked]: /docs/not-an-image.png
`;
    const diags = lintBased(setup, mdx);
    assert.equal(diags.length, 1, diags.map((d) => d.message).join("\n"));
    assert.equal(
      diags[0]!.message,
      'definition "/docs/arch.png" repeats the site base "/docs"; Nimbus adds it, so it renders as "/docs/docs/arch.png". Write "/arch.png".',
    );
    assert.equal(diags[0]!.line, mdx.split("\n").indexOf("[arch]: /docs/arch.png") + 1);
    const out = fixed(setup, mdx);
    assert.ok(out.includes("[arch]: /arch.png\n"));
    assert.equal(out.match(/\[arch\]: \/arch\.png/g)?.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref under a base: a missing definition is reported once, with no fix", () => {
  const setup = setupProject();
  try {
    const diags = lintBased(
      setup,
      `${FM}
![A][gone] ![B][gone] ![C][based]

[gone]: /gone.png
[based]: /docs/gone.png
`,
    );
    assert.equal(diags.length, 2);
    assert.match(diags[0]!.message, /missing image "\/gone\.png" — expected at public\/gone\.png\.$/);
    assert.match(diags[1]!.message, /expected at public\/docs\/gone\.png\. Nimbus adds the site base "\/docs" to definitions/);
    assert.ok(diags.every((d) => d.fix === undefined));
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref under a base: the inline fix edits only a destination it can see", () => {
  const setup = setupProject(["public/arch.png"]);
  try {
    assert.equal(
      fixed(setup, `${FM}\n![Arch](/arch.png?v=2#preview "Title")\n`),
      `${FM}\n![Arch](/docs/arch.png?v=2#preview "Title")\n`,
    );
    assert.equal(fixed(setup, `${FM}\n![Arch]( </arch.png> )\n`), `${FM}\n![Arch]( </docs/arch.png> )\n`);
    // The alt text holds the only literal "](/arch.png"; the destination is escaped.
    const lookAlike = `${FM}\n![label \\](/arch.png)](/arch\\.png)\n`;
    const diags = lintBased(setup, lookAlike);
    assert.equal(diags.length, 1);
    assert.equal(diags[0]!.fix, undefined);
    assert.equal(fixed(setup, lookAlike), lookAlike);
    for (const destination of ["/arch\\.png", "/arch&#46;png"]) {
      const source = `${FM}\n![Arch](${destination})\n`;
      assert.equal(lintBased(setup, source)[0]?.fix, undefined, destination);
      assert.equal(fixed(setup, source), source, destination);
    }
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref under a base: fixes are idempotent", () => {
  const setup = setupProject(["public/arch.png"]);
  try {
    const mdx = `${FM}\n![Arch](/arch.png)\n\n![Ref][r]\n\n[r]: /docs/arch.png\n`;
    const once = fixed(setup, mdx);
    assert.equal(once, `${FM}\n![Arch](/docs/arch.png)\n\n![Ref][r]\n\n[r]: /arch.png\n`);
    assert.equal(fixed(setup, once), once);
    assert.deepEqual(lintBased(setup, once), []);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref under a base: components accept both forms, with no base report", () => {
  const setup = setupProject(["public/arch.png"]);
  try {
    const diags = lintBased(
      setup,
      `${FM}
<Figure src="/arch.png" />
<Figure src="/docs/arch.png" />
<Figure src="/docs/gone.png" />
`,
      { components: [{ name: "Figure", attr: "src" }] },
    );
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /^missing image "\/docs\/gone\.png" — expected at public\/gone\.png\.$/);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref under a base: ignore matches the URL as written and aliases resolve before the base", () => {
  const setup = setupProject(["public/arch.png", "src/assets/shot.png"]);
  try {
    const diags = lintBased(
      setup,
      `${FM}
![Ignored](/arch.png)

![Aliased](/assets/shot.png)
`,
      { ignore: ["/arch.png"], aliases: { "/assets/": "src/assets/" } },
    );
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref under a base: an encoded base in a definition gets no rewrite", () => {
  const setup = setupProject(["public/arch.png"]);
  try {
    const mdx = `${FM}\n![Ref][r]\n\n[r]: /%64ocs/arch.png\n`;
    const diags = lintBased(setup, mdx);
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /repeats the site base "\/docs".*Write it without the base\.$/);
    assert.equal(diags[0]!.fix, undefined);
    assert.equal(fixed(setup, mdx), mdx);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref with no base keeps today's behaviour", () => {
  const setup = setupProject(["public/arch.png"]);
  try {
    assert.deepEqual(lint(setup, `${FM}\n![A](/arch.png)\n\n![B][b]\n\n[b]: /arch.png\n`), []);
    const diags = lint(setup, `${FM}\n![A](/docs/arch.png)\n`);
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /expected at public\/docs\/arch\.png/);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref under an encoded base compares it decoded and writes it as configured", () => {
  const setup = setupProject(["public/arch.png"]);
  try {
    const parsed = parseSource(`${FM}\n![A](/caf%C3%A9/arch.png)\n\n![B](/arch.png)\n`, {
      path: "src/content/docs/page.mdx",
      absPath: setup.pagePath,
      collection: "docs",
    });
    const diags = lintFile(parsed, { base: "/caf%C3%A9", rules: { "nimbus/image-ref": "error" } });
    assert.equal(diags.length, 1, diags.map((d) => d.message).join("\n"));
    assert.equal(diags[0]!.message, 'image "/arch.png" skips the site base "/caf%C3%A9" and won\'t load. Write "/caf%C3%A9/arch.png".');
  } finally {
    cleanup(setup.root);
  }
});
