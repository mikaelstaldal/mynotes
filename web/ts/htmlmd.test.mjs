// node:test coverage for web/ts/util/htmlmd.ts (exercised via its compiled
// output, web/static/util/htmlmd.js).  Run via build.sh or directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/htmlmd.test.mjs
//
// This is the demo backend's HTML import: the service worker has no DOMParser,
// so it hands the document to the page, which converts it here (see
// web/ts/demo-client.ts).  The module is a port of internal/htmlmd, and the
// cases below are the ones where the two must agree — the expected output is
// what the Go converter produces for the same input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// jsdom supplies DOMParser and Node, which htmlmd.js reads as globals.
const { JSDOM } = await import(path.resolve(__dirname, 'vendor/test/jsdom.js'));
const { window } = new JSDOM('');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = window.DOMParser;
globalThis.Node = window.Node;

const { htmlToMarkdown } = await import(path.resolve(__dirname, '../static/util/htmlmd.js'));

/** The converted body, with the block padding the converter emits collapsed. */
function md(html) {
  return htmlToMarkdown(html).content.split('\n').map((l) => l.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

test('the title comes from <title>, else the first heading', () => {
  assert.equal(htmlToMarkdown('<html><head><title>From Title</title></head><body><h1>H</h1></body></html>').title,
    'From Title');
  assert.equal(htmlToMarkdown('<body><h2>From Heading</h2><p>x</p></body>').title, 'From Heading');
  assert.equal(htmlToMarkdown('<body><p>No heading at all</p></body>').title, '');
});

test('headings become ATX headings', () => {
  assert.equal(md('<h1>One</h1><h3>Three</h3><h6>Six</h6>'), '# One\n\n### Three\n\n###### Six');
});

test('inline formatting becomes Markdown', () => {
  assert.equal(md('<p>a <strong>b</strong> <em>c</em> <del>d</del> <code>e</code></p>'),
    'a **b** *c* ~~d~~ `e`');
});

test('links and images keep their destinations', () => {
  assert.equal(md('<p><a href="https://example.com">text</a></p>'), '[text](https://example.com)');
  assert.equal(md('<p><a>no href</a></p>'), 'no href');
  assert.equal(md('<img src="/x.png" alt="An image">'), '![An image](/x.png)');
  assert.equal(md('<img alt="no src">'), '', 'an image with no source is dropped');
});

test('lists nest, and a checkbox becomes a task item', () => {
  assert.equal(md('<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>'),
    '- one\n- two\n  - nested');
  assert.equal(md('<ol><li>first</li><li>second</li></ol>'), '1. first\n2. second');
  assert.equal(md('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>'),
    '- [x] done\n- [ ] todo');
});

test('pre becomes a fenced block, tagged with its language class', () => {
  // The source's trailing newline survives into the block, as it does on the
  // server — the fence closes on the line after it.
  assert.equal(md('<pre><code class="language-js">const x = 1;\n</code></pre>'),
    '```js\nconst x = 1;\n\n```');
  assert.equal(md('<pre><code>plain</code></pre>'), '```\nplain\n```');
});

test('blockquotes are prefixed line by line', () => {
  assert.equal(md('<blockquote><p>One.</p><p>Two.</p></blockquote>'), '> One.\n>\n> Two.');
});

test('tables become GFM tables with their alignment', () => {
  assert.equal(
    md('<table><thead><tr><th align="right">A</th><th>B</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'),
    '| A | B |\n| ---: | --- |\n| 1 | 2 |');
});

test('a cell cannot break out of the table', () => {
  // Escaped twice — once as inline text, once as a cell — matching the server.
  assert.equal(md('<table><tr><td>a|b</td><td>c</td></tr></table>'),
    '| a\\\\|b | c |\n| --- | --- |');
});

test('script and style are dropped whole; unknown tags keep their text', () => {
  assert.equal(md('<p>before</p><script>alert(1)</script><style>p{}</style><p>after</p>'),
    'before\n\nafter');
  assert.equal(md('<p>a <fancy>kept text</fancy> b</p>'), 'a kept text b');
});

test('elements with no Markdown equivalent survive as safe HTML', () => {
  assert.equal(md('<p><abbr title="abbreviation">abbr</abbr> and <kbd>Ctrl</kbd></p>'),
    '<abbr title="abbreviation">abbr</abbr> and <kbd>Ctrl</kbd>');
});

test('disallowed attributes are stripped from the HTML passthrough', () => {
  const out = md('<p><mark onclick="alert(1)" class="x">hi</mark></p>');
  assert.equal(out, '<mark>hi</mark>');
});

test('text carrying Markdown syntax is escaped', () => {
  assert.equal(md('<p>a *star* and _underscore_ and [bracket]</p>'),
    'a \\*star\\* and \\_underscore\\_ and \\[bracket\\]');
  // '>' is deliberately not escaped: blockquote syntax only triggers at line start.
  assert.equal(md('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'),
    '\\<script>alert(1)\\</script>');
  // The sub/superscript delimiters, so imported text does not become markup.
  assert.equal(md('<p>H~2~O and a^b^c</p>'), 'H\\~2\\~O and a\\^b\\^c');
});

test('hr and br become their Markdown forms', () => {
  assert.equal(md('<p>a<br>b</p>'), 'a\nb');
  assert.equal(md('<p>x</p><hr><p>y</p>'), 'x\n\n---\n\ny');
});

test('a whole document converts end to end', () => {
  const doc = `<!DOCTYPE html><html><head><title>Doc</title></head><body>
    <div><h1>A Heading</h1>
    <p>Some <strong>bold</strong> text and a <a href="https://example.com">link</a>.</p>
    <ul><li>one</li><li>two</li></ul></div>
    </body></html>`;
  assert.equal(htmlToMarkdown(doc).title, 'Doc');
  assert.equal(md(doc),
    '# A Heading\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two');
});
