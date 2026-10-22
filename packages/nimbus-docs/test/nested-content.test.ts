// NestedContent: rendered content inside another page's outline.
import assert from "node:assert/strict";
import { test } from "node:test";

import { nestContent } from "../src/_internal/nested-content.ts";

const nest = (html: string, sourceUrl?: string) =>
  nestContent(html, { headingLevel: 4, ...(sourceUrl ? { sourceUrl } : {}) });

test("headings start at headingLevel, keep their offset down to h6, and lose their ids", () => {
  assert.equal(
    nest('<h1 id="a">A</h1><h2 id="b" class="x">B</h2><h3 id="c">C</h3><h4>D</h4><h5>E</h5><h6>F</h6>'),
    '<h4>A</h4><h4 class="x">B</h4><h5>C</h5><h6>D</h6><h6>E</h6><h6>F</h6>',
  );
  assert.equal(nestContent("<h2>B</h2><h3>C</h3>", { headingLevel: 3 }), "<h3>B</h3><h4>C</h4>");
});

test("links to a removed section go to the page where it lives; other links stay", () => {
  assert.equal(
    nest(
      '<h2 id="fixed">Fixed</h2><h2 id="新機能">新機能</h2>' +
        '<a href="#fixed">a</a><a href="&#35;fixed">b</a><a href="#%E6%96%B0%E6%A9%9F%E8%83%BD">c</a>' +
        '<a href="#elsewhere">d</a><a data-href="#fixed" href="/x">e</a>',
      "/docs/changelog/one/",
    ),
    "<h4>Fixed</h4><h4>新機能</h4>" +
      '<a href="/docs/changelog/one/#fixed">a</a><a href="/docs/changelog/one/#fixed">b</a>' +
      '<a href="/docs/changelog/one/#%E6%96%B0%E6%A9%9F%E8%83%BD">c</a>' +
      '<a href="#elsewhere">d</a><a data-href="#fixed" href="/x">e</a>',
  );
  // Without sourceUrl, links are left as written.
  assert.equal(nest('<h2 id="fixed">Fixed</h2><a href="#fixed">a</a>'), '<h4>Fixed</h4><a href="#fixed">a</a>');
});

test("only headings and their section links change: scripts, styles, textareas, comments and attributes keep their meaning", () => {
  const untouched =
    '<script data-example="</script>">const s = "<h2 id=\'keep\'>";</script>' +
    "<style>h2[id] { color: red }</style>" +
    '<textarea><h2 id="raw">raw</h2></textarea>' +
    "<!-- <h2 id=\"c\"> -->" +
    '<p title="a > b &#x110000;">Text with href="#fixed"</p>';
  const out = nest(`<h2 title='a "quoted" > b' id="fixed">Fixed</h2>${untouched}<a href='#fixed'>x</a>`, "/one/");
  assert.match(out, /^<h4 title="a &#x22;quoted&#x22; > b">Fixed<\/h4>/);
  assert.match(out, /<script data-example="<\/script>">const s = "<h2 id='keep'>";<\/script>/);
  assert.match(out, /<style>h2\[id\] \{ color: red \}<\/style>/);
  // Textarea text is serialized escaped; it reads the same.
  assert.match(out, /<textarea>&#x3C;h2 id="raw">raw&#x3C;\/h2><\/textarea>/);
  assert.match(out, /<!-- <h2 id="c"> -->/);
  assert.match(out, /<p title="a > b �">Text with href="#fixed"<\/p>/);
  assert.match(out, /<a href="\/one\/#fixed">x<\/a>$/);
});
