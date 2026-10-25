import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "astro";

import nimbus from "../src/index.js";
import { math } from "../src/markdown/index.js";
import { runningNimbusVersion } from "../src/_internal/upgrades.js";
import { TEST_TMP } from "./fixtures/temp-root.js";

const src = path.resolve(import.meta.dirname, "../src");
const module = (file: string) => JSON.stringify(pathToFileURL(path.join(src, file)).href);

const PAGE = `---
title: Physics
---
Energy is $E = mc^2$, and $\\R^n$ uses a site macro.

$$
\\begin{equation}
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\label{eq:quadratic}
\\end{equation}
$$

\`\`\`math
\\int_0^1 x\\,dx
\`\`\`

As $\\eqref{eq:quadratic}$ shows.

Broken: $\\frac{1}{$ and $\\nosuchcommand$.
`;

async function site(hastPlugins: unknown[], features: Record<string, unknown> = { math: true }, page = PAGE) {
  // The real path: Astro only adds injected page styles to files under its root as written.
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-math-")));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  await symlink(path.resolve(import.meta.dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
  await write("package.json", '{"type":"module"}');
  await write("nimbus.json", JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }));
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content";
import { docsCollection } from ${module("content.ts")};
export const collections = { docs: defineCollection(docsCollection()) };
`,
  );
  await write("src/components.ts", "export const components = {};\n");
  await write("src/content/docs/physics.mdx", page);
  await write("src/content/docs/plain.md", "---\ntitle: Plain\n---\nIt costs $5.\n");
  await write(
    "src/pages/[...slug].astro",
    `---
import { getDocsStaticPaths, getDocsPageProps } from ${module("runtime.ts")};
export const prerender = true;
export const getStaticPaths = getDocsStaticPaths;
const { entry, Content } = await getDocsPageProps(Astro);
---
<html><head><title>{entry.data.title}</title></head><body><Content /></body></html>
`,
  );
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${module("agent-endpoints.ts")};
export const prerender = true;
export const { GET, getStaticPaths } = markdownRoute();
`,
  );
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    await build({
      root: pathToFileURL(root + path.sep),
      configFile: false,
      cacheDir: path.join(root, ".astro"),
      logLevel: "silent",
      vite: {
        cacheDir: path.join(root, ".vite"),
        resolve: {
          alias: [
            { find: /^@cloudflare\/nimbus-docs\//, replacement: src + "/" },
            { find: /^@cloudflare\/nimbus-docs$/, replacement: path.join(src, "index.ts") },
          ],
        },
      },
      integrations: [
        nimbus(
          { site: "https://example.test", title: "Example", search: false },
          { sitemap: false, icons: false, markdown: { features, hastPlugins } },
        ),
      ],
    });
  } finally {
    console.warn = warn;
  }
  const read = (file: string) => readFile(path.join(root, file), "utf8");
  const css = async () => {
    const dir = path.join(root, "dist/_astro");
    const files = await readdir(dir).catch(() => [] as string[]);
    return (await Promise.all(files.filter((f) => f.endsWith(".css")).map((f) => readFile(path.join(dir, f), "utf8")))).join("\n");
  };
  return { root, read, css, warnings };
}

test("math() typesets inline, display and fenced math as MathML, with the TeX kept", async () => {
  const s = await site([math({ macros: { "\\R": "\\mathbb{R}" } })]);
  try {
    const html = await s.read("dist/physics/index.html");
    // Two inline formulas, one `$$` block, one ```math fence, and the filled \eqref.
    assert.equal(html.match(/<math\b/g)?.length, 5, html);
    assert.match(html, /<div class="nb-math"><math display="block"/);
    assert.match(html, /<annotation encoding="application\/x-tex" data-pagefind-ignore="">E = mc\^2<\/annotation>/);
    assert.match(html, /<mi>ℝ<\/mi>/, "site macro \\R");
    assert.match(html, /<a href="#eqquadratic" class="tml-ref tml-eqref"><math><mtext>\(1\)<\/mtext><\/math><\/a>/);
    assert.doesNotMatch(html, /language-math|astro-code[^>]*>[^<]*\\int/, "no code block left for math");

    // Errors warn with the file and line, and render a marked span; the build goes on.
    assert.match(html, /<code class="nb-math-error" title="[^"]+">\\frac\{1\}\{<\/code>/);
    assert.match(html, /<code class="nb-math-error" title="[^"]+">\\nosuchcommand<\/code>/);
    const mathWarnings = s.warnings.filter((w) => w.includes("Math error"));
    assert.equal(mathWarnings.length, 2, mathWarnings.join("\n"));
    assert.ok(mathWarnings.every((w) => /physics\.mdx:18: /.test(w)), mathWarnings.join("\n"));

    // Agents read the TeX as written.
    const markdown = await s.read("dist/physics/index.md");
    assert.match(markdown, /Energy is \$E = mc\^2\$/);
    assert.match(markdown, /```math\n\\int_0\^1 x\\,dx\n```/);

    const css = await s.css();
    assert.match(css, /font-family:\s*"?Nimbus Math"?/);
    assert.match(css, /url\("?\/_astro\/stix-two-math[^)]*\.woff2/, "the font url is resolved to a built asset");
    assert.match(css, /tml-eqn/, "Temml's stylesheet, which numbers equations");
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("without math(), math stays code and no math stylesheet ships", async () => {
  const s = await site([]);
  try {
    assert.match(await s.read("dist/physics/index.html"), /class="language-math math-inline"/);
    assert.doesNotMatch(await s.css(), /Nimbus Math|tml-eqn/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("with math() but math off, no math stylesheet ships", async () => {
  // A page without math, as on a site that hasn't turned it on; prices stay text.
  const s = await site([math()], {}, "---\ntitle: Physics\n---\nIt costs $5 and $10.\n");
  try {
    assert.match(await s.read("dist/physics/index.html"), /It costs \$5 and \$10\./);
    assert.doesNotMatch(await s.css(), /Nimbus Math|tml-eqn/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});
