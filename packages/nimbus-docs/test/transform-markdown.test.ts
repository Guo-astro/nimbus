// Generated Markdown for MDX pages: fenced code must survive byte-for-byte,
// and component renderers must emit the same commands as their HTML.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { renderEntryAsMarkdown } from "../src/_internal/transform.js";
import { getTabs, type CommandType } from "../src/lib/pkgm.js";

const mdx = (body: string) =>
  renderEntryAsMarkdown({ body, filePath: "page.mdx" });

const yaml = [
  "paths:",
  "  /v1/events/{event_id}:",
  "    get:",
  "      operationId: retrieveEvent",
].join("\n");

const python = [
  "def outer():",
  "    def inner():",
  "        return 1",
  "",
  "",
  "    return inner",
].join("\n");

const nestedList = ["- one", "    - two", "        - three"].join("\n");

describe("renderEntryAsMarkdown: fenced code fidelity", () => {
  for (const [lang, code] of [
    ["yaml", yaml],
    ["python", python],
    ["markdown", nestedList],
  ] as const) {
    test(`top-level ${lang} keeps its indentation`, () => {
      const out = mdx(`Intro.\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\nOutro.`);
      assert.ok(
        out.includes(`\`\`\`${lang}\n${code}\n\`\`\``),
        `expected verbatim block, got:\n${out}`,
      );
    });
  }

  test("a fence indented inside JSX drops only its own indentation", () => {
    const indented = yaml
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    const out = mdx(
      `<Wrapper>\n  <Inner>\n    \`\`\`yaml\n${indented}\n    \`\`\`\n  </Inner>\n</Wrapper>`,
    );
    assert.ok(out.includes(`\`\`\`yaml\n${yaml}\n\`\`\``), out);
  });

  test("code inside <Aside> gets the quote prefix on every line", () => {
    const out = mdx(
      `<Aside type="caution">\n\nCheck this:\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n</Aside>`,
    );
    const quoted = ["```yaml", ...yaml.split("\n"), "```"]
      .map((line) => `> ${line}`)
      .join("\n");
    assert.ok(out.includes(quoted), `expected quoted block, got:\n${out}`);
  });

  test("code inside an indented <Aside> keeps relative indentation", () => {
    const out = mdx(
      `<Aside>\n  \`\`\`python\n${python
        .split("\n")
        .map((line) => (line ? `  ${line}` : line))
        .join("\n")}\n  \`\`\`\n</Aside>`,
    );
    const quoted = ["```python", ...python.split("\n"), "```"]
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    assert.ok(out.includes(quoted), `expected quoted block, got:\n${out}`);
  });

  test("longer fences and tilde fences are protected whole", () => {
    const body = "````md\n```js\n    <Card title=\"x\" />\n```\n````\n\n~~~txt\n    <Aside>keep</Aside>\n~~~";
    assert.equal(mdx(body), body);
  });

  test("CRLF blocks and several inline spans per line survive", () => {
    const block = "```yaml\r\na:\r\n    b: 1\r\n```";
    const out = mdx(`Use \`a\` and \`b\`.\r\n\r\n${block}\r\n`);
    assert.ok(out.includes("Use `a` and `b`."), out);
    assert.ok(out.includes(block), JSON.stringify(out));
  });

  test("a fence written inside a source blockquote keeps its markers", () => {
    const body = "> ```yaml\n> a:\n>     b: 1\n>\n> ```";
    assert.equal(mdx(body), body);
  });

  test("Markdown files are returned unchanged", () => {
    const body = `\`\`\`yaml\n${yaml}\n\`\`\``;
    assert.equal(
      renderEntryAsMarkdown({ body, filePath: "page.md" }),
      body,
    );
  });
});

describe("renderEntryAsMarkdown: <PackageManagers>", () => {
  const cases: Array<{
    type: CommandType;
    attrs: string;
    pkg?: string;
    args?: string;
    dev?: boolean;
  }> = [
    { type: "add", attrs: 'pkg="astro"', pkg: "astro" },
    { type: "add", attrs: 'pkg="vitest" dev', pkg: "vitest", dev: true },
    {
      type: "create",
      attrs: 'type="create" pkg="astro@latest"',
      pkg: "astro@latest",
    },
    {
      type: "dlx",
      attrs: 'type="dlx" pkg="@cloudflare/nimbus-docs" args="list"',
      pkg: "@cloudflare/nimbus-docs",
      args: "list",
    },
    {
      type: "exec",
      attrs: 'type="exec" pkg="astro" args="check"',
      pkg: "astro",
      args: "check",
    },
    { type: "install", attrs: 'type="install"' },
    { type: "remove", attrs: 'type="remove" pkg="astro"', pkg: "astro" },
    { type: "run", attrs: 'type="run" pkg="build"', pkg: "build" },
  ];

  for (const { type, attrs, pkg, args, dev } of cases) {
    test(`type=${type} (${attrs}) matches the HTML commands`, () => {
      const out = mdx(`<PackageManagers ${attrs} />`);
      const expected = getTabs(type, pkg, { args, dev }).map((t) => t.cmd);
      assert.equal(out, ["```sh", ...expected, "```"].join("\n"));
      if (pkg) {
        const name = pkg.replace(/(?<=.)@[^/]*$/, "");
        for (const line of expected) assert.ok(line.includes(name), line);
      }
    });
  }

  test("dlx keeps the package: npx @cloudflare/nimbus-docs list", () => {
    const out = mdx(
      '<PackageManagers pkg="@cloudflare/nimbus-docs" type="dlx" args="list" />',
    );
    assert.match(out, /^npx @cloudflare\/nimbus-docs list$/m);
  });

  test("run renders the named script, not dev", () => {
    const out = mdx('<PackageManagers pkg="build" type="run" />');
    assert.match(out, /^npm run build$/m);
    assert.doesNotMatch(out, /\bdev\b/);
  });

  test("a comment is emitted once above the commands", () => {
    const out = mdx(
      '<PackageManagers pkg="@cloudflare/nimbus-docs" type="dlx" args="init" comment="scan a nested package" />',
    );
    assert.equal(out.match(/# scan a nested package/g)?.length, 1);
    assert.match(out, /^npx @cloudflare\/nimbus-docs init$/m);
  });
});

test("a fence opened on a list-item line stays inside the item", () => {
  const source = ["1. Run:", "", "- ```yaml", "  paths:", "    /a: {}", "  ```", "", "  Then build."].join("\n");
  const out = mdx(source);
  assert.ok(out.includes(["- ```yaml", "  paths:", "    /a: {}", "  ```"].join("\n")), out);
  assert.ok(out.includes("  Then build."), out);
});

describe("renderEntryAsMarkdown: fences inside list items", () => {
  test("a fence in a nested list item stays in the item, and so does the prose after it", () => {
    assert.equal(
      mdx("- Outer\n  - Inner:\n\n    ```sh\n    run\n    ```\n\n    Prose after.\n"),
      "- Outer\n  - Inner:\n\n    ```sh\n    run\n    ```\n\n    Prose after.",
    );
  });

  test("a fence in an ordered item doesn't split the list", () => {
    assert.equal(
      mdx("1. First:\n\n   ```sh\n   run\n   ```\n\n   More.\n2. Second\n"),
      "1. First:\n\n   ```sh\n   run\n   ```\n\n   More.\n2. Second",
    );
  });

  // 4+ columns past the item's content, or tab-indented, the fence would read
  // as indented code; it moves to the item's content column instead.
  test("an over-indented fence in a list item moves to the item's content column", () => {
    assert.equal(
      mdx("- Step:\n\n      ```sh\n      x\n      ```\n\n  After.\n"),
      "- Step:\n\n  ```sh\n  x\n  ```\n\n  After.",
    );
  });

  test("a tab-indented fence in a list item moves to the item's content column", () => {
    assert.equal(mdx("- Step:\n\n\t```sh\n\tx\n\t```\n"), "- Step:\n\n  ```sh\n  x\n  ```");
  });

  test("a fence indented only by component markup still moves to column 0", () => {
    assert.equal(
      mdx('<Tabs>\n  <TabItem label="A">\n    ```sh\n    a\n    ```\n  </TabItem>\n</Tabs>\n'),
      "### A\n\n```sh\na\n```",
    );
  });
});

describe("renderEntryAsMarkdown: lists inside components", () => {
  test("a list item inside <Aside> keeps its code block and prose", () => {
    assert.equal(
      mdx('<Aside type="tip">\n  Before:\n\n  1. Install:\n\n     ```sh\n     npm i x\n     ```\n\n     Then run it.\n  2. Check.\n</Aside>\n'),
      "> **Tip**\n>\n> Before:\n>\n> 1. Install:\n>\n>    ```sh\n>    npm i x\n>    ```\n>\n>    Then run it.\n> 2. Check.",
    );
  });

  test("a list item inside <Step> keeps its prose", () => {
    assert.equal(
      mdx('<Steps>\n  <Step title="Configure">\n    Set:\n\n    - One\n\n      More about one.\n    - Two\n  </Step>\n</Steps>\n'),
      "1. **Configure**\n\n   Set:\n\n   - One\n\n     More about one.\n   - Two",
    );
  });

  test("a list item inside <TabItem> keeps its code block", () => {
    assert.equal(
      mdx('<Tabs>\n  <TabItem label="npm">\n    1. Run:\n\n       ```sh\n       npm i\n       ```\n  </TabItem>\n</Tabs>\n'),
      "### npm\n\n1. Run:\n\n   ```sh\n   npm i\n   ```",
    );
  });

  test("an <Aside> inside a list item stays in the item", () => {
    assert.equal(
      mdx("- Setup:\n\n  <Aside>\n    Careful.\n\n    Twice.\n  </Aside>\n- Next\n"),
      "- Setup:\n\n  > **Note**\n  >\n  > Careful.\n  >\n  > Twice.\n- Next",
    );
  });
});

describe("renderEntryAsMarkdown: components without a renderer", () => {
  test("nested wrappers unwrap fully, and a title leads its item", () => {
    const out = mdx(
      '<AccordionGroup>\n  <Accordion title="How do I deploy?">\n    Run `deploy`.\n  </Accordion>\n  <Accordion title="Can I preview?">\n    Yes.\n  </Accordion>\n</AccordionGroup>\n',
    );
    assert.doesNotMatch(out, /<\/?[A-Z]/);
    assert.equal(out, "**How do I deploy?**\n\nRun `deploy`.\n\n**Can I preview?**\n\nYes.");
  });

  test("a wrapper without a title keeps just its children", () => {
    assert.equal(mdx("<Frame>\n  <Popover>Hover me</Popover>\n</Frame>\n"), "Hover me");
  });
});

test("a titled component inside a list item stays in the item", () => {
  assert.equal(
    mdx('- <Accordion title="Why?">Because.</Accordion>\n- Next\n'),
    "- **Why?**\n\n  Because.\n- Next",
  );
});

describe("renderEntryAsMarkdown: component placement", () => {
  test("<Steps> right under an HTML wrapper keeps the blank line that ends the HTML block", () => {
    assert.equal(
      mdx('<div class="x">\n<Steps>\n  <Step title="Install">\n    Run it.\n  </Step>\n</Steps>\n</div>\n'),
      '<div class="x">\n\n1. **Install**\n\n   Run it.\n\n</div>',
    );
  });

  test("cards under an HTML wrapper stay a list", () => {
    assert.equal(
      mdx('<div>\n  <CardGrid>\n    <Card title="A">one</Card>\n    <Card title="B">two</Card>\n  </CardGrid>\n</div>\n'),
      "<div>\n\n- **A** — one\n- **B** — two\n\n</div>",
    );
  });

  test("<Steps> and <Tabs> under a nested list item sit at the item's content column", () => {
    assert.equal(
      mdx('- Setup\n  - Sub step:\n\n    <Steps>\n      <Step title="Install">\n        Run it.\n      </Step>\n    </Steps>\n'),
      "- Setup\n  - Sub step:\n\n    1. **Install**\n\n       Run it.",
    );
    assert.equal(
      mdx('1. Pick:\n   - One of:\n\n     <Tabs>\n       <TabItem label="npm">\n         npm i\n       </TabItem>\n     </Tabs>\n'),
      "1. Pick:\n   - One of:\n\n     ### npm\n\n     npm i",
    );
  });

  test("<Steps> inside a card starts on its own line within the card", () => {
    assert.equal(
      mdx('<Card title="Setup">\n  <Steps>\n    <Step title="Install">\n      Run it.\n    </Step>\n  </Steps>\n</Card>\n'),
      "- **Setup** — \n\n  1. **Install**\n\n     Run it.",
    );
  });

  test("a bold-led list item stays inside its step", () => {
    assert.equal(
      mdx('<Steps>\n  <Step title="Config">\n    Set:\n\n    - **site**: the URL\n\n      ```ts\n      site: "x"\n      ```\n  </Step>\n</Steps>\n'),
      '1. **Config**\n\n   Set:\n\n   - **site**: the URL\n\n     ```ts\n     site: "x"\n     ```',
    );
  });

  test("a nested bold-led list outside components keeps its nesting", () => {
    assert.equal(mdx("- Genres:\n  - **Dated** — per release\n"), "- Genres:\n  - **Dated** — per release");
  });

  test("indentation outside a list item never becomes indented code", () => {
    assert.equal(
      mdx("<Aside>\nThis is important.\n\n    Keep this in mind.\n</Aside>\n"),
      "> **Note**\n>\n> This is important.\n>\n> Keep this in mind.",
    );
  });

  test("a component inside a blockquote isn't quoted twice", () => {
    assert.equal(mdx('> <Accordion title="T">\n> body\n> </Accordion>\n'), "> **T**\n>\n> body");
    assert.equal(mdx("> <Aside>\n> quoted\n> </Aside>\n"), "> > **Note**\n> >\n> > quoted");
  });

  test("a titled component mid-sentence keeps only its text", () => {
    assert.equal(mdx('Click <Tooltip title="hint">here</Tooltip> to continue.\n'), "Click here to continue.");
  });

  test("only string titles show; an expression title falls back", () => {
    assert.equal(mdx('<Aside title={"Heads up"}>\n  Body.\n</Aside>\n'), "> **Heads up**\n>\n> Body.");
    assert.equal(mdx('<Aside title={t("warn")}>\n  Body.\n</Aside>\n'), "> **Note**\n>\n> Body.");
  });

  test("a trigger and its content become separate paragraphs", () => {
    assert.equal(
      mdx("<AccordionItem>\n  <AccordionTrigger>What is it?</AccordionTrigger>\n  <AccordionContent>A framework.</AccordionContent>\n</AccordionItem>\n"),
      "What is it?\n\nA framework.",
    );
  });

  test("an HTML line after a list in a component ends the list", () => {
    assert.equal(
      mdx("<Frame>\n  <div>\n\n  - one\n\n  </div>\n</Frame>\n"),
      "<div>\n\n- one\n\n</div>",
    );
  });
});

test("a body that starts with blank lines still places indented components", () => {
  assert.equal(mdx("\n\n  <Aside>\n    Hi.\n  </Aside>\n"), "> **Note**\n>\n> Hi.");
});
