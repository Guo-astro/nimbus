import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pagefindDocument,
  pagefindMarkdown,
} from "../src/_internal/pagefind-document.js";

test("synthetic Pagefind Markdown preserves headings as subresult anchors", () => {
  const html = pagefindMarkdown(
    "Intro.\n\n## Partial heading\n\nBody.\n\n## Partial heading\n\n```md\n## Not a heading\n```",
  );

  assert.match(html, /<h2 id="partial-heading">Partial heading<\/h2>/);
  assert.match(html, /<h2 id="partial-heading-1">Partial heading<\/h2>/);
  assert.doesNotMatch(html, /<h2 id="not-a-heading">/);
  assert.match(html, /<pre>[\s\S]*## Not a heading[\s\S]*<\/pre>/);
});

test("synthetic Pagefind headings cannot inject incomplete HTML tags", () => {
  const html = pagefindMarkdown("## Before <script after");

  assert.equal(html, '<h2 id="before-script-after">Before script after</h2>');
  assert.doesNotMatch(html, /<script/i);
  assert.equal(
    pagefindMarkdown("## Before <em>after</em>"),
    '<h2 id="before-after">Before after</h2>',
  );
});

test("synthetic Pagefind document retains route metadata and heading HTML", () => {
  const html = pagefindDocument({
    url: "/v1/runtime/",
    title: "Runtime",
    description: "Request-rendered content",
    content: "## Configure it\n\nSearchable text.",
    language: "en",
    version: "v1",
    deprecated: true,
  });

  assert.match(html, /data-pagefind-filter="version:v1"/);
  assert.match(html, /data-pagefind-filter="status:deprecated"/);
  assert.match(html, /<h2 id="configure-it">Configure it<\/h2>/);
});

test("synthetic Pagefind prose reads as text, not Markdown syntax", () => {
  const html = pagefindMarkdown(
    "Operations.\n\n- [List items](/reference/items/list/) reads `items[0]` and _more_\n- **Deprecated.**\n\n<b onclick=\"x()\">Raw</b> text, <script>bad()</script> and <script unclosed\n\nAfter.",
  );
  assert.match(html, /<a>List items<\/a> reads <code>items\[0\]<\/code> and <em>more<\/em>/);
  assert.match(html, /<li><strong>Deprecated\.<\/strong><\/li>/);
  assert.doesNotMatch(html, /\]\(|`|_more_|^- /m);
  assert.doesNotMatch(html, /<script|onclick|bad\(\)|<b>/);
  assert.match(html, /Raw text/);
  assert.match(html, /<p>After\.<\/p>/, "an unclosed tag swallows nothing after it");
});

test("synthetic Pagefind prose resolves reference links defined after a heading", () => {
  const html = pagefindMarkdown("See [Options][options].\n\n## Later\n\n[options]: /options/\n");
  assert.match(html, /See <a>Options<\/a>\./);
  assert.doesNotMatch(html, /\[options\]/i);
});
