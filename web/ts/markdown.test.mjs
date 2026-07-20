// node:test coverage for web/ts/util/markdown.ts (exercised via its compiled
// output, web/static/util/markdown.js).  Run via build.sh or directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/markdown.test.mjs
//
// The loader (test-preload.mjs → test-hooks.mjs) maps the 'markdown-it' and
// 'dompurify' bare specifiers in the compiled module to the real committed
// vendor bundles in web/static/vendor/, so any bundle regression is caught
// here too.  No npm install is required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// jsdom must be installed in globalThis BEFORE markdown.js is evaluated:
// DOMPurify detects its own environment (reads `window`) at module-load time.
const { JSDOM } = await import(path.resolve(__dirname, 'vendor/test/jsdom.js'));
const { window } = new JSDOM('');
globalThis.window = window;
globalThis.document = window.document;

// Dynamic import so markdown.js (and the DOMPurify it imports) sees the
// globals set above.  The loader hook resolves 'markdown-it' and 'dompurify'
// to the committed esbuild bundles.
const { renderNote, rawHtmlBlockSeparator } = await import(path.resolve(__dirname, '../static/util/markdown.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertAbsent(out, pat, label) {
  assert.ok(!out.includes(pat), `${label}: "${pat}" must NOT appear; got:\n${out}`);
}

function assertPresent(out, pat, label) {
  assert.ok(out.includes(pat), `${label}: "${pat}" must appear; got:\n${out}`);
}

// ---------------------------------------------------------------------------
// Malicious inputs — script / event-handler / disallowed-scheme must not survive
// ---------------------------------------------------------------------------

test('<script> tag and content are stripped', () => {
  const out = renderNote('<script>alert("xss")</script>');
  assertAbsent(out, '<script', 'script tag');
  assertAbsent(out, 'alert("xss")', 'script content');
});

// Parity vector: onerror stripped by both DOMPurify (client) and bluemonday
// (server).  The <img> element itself is kept; only the event handler is gone.
test('<img onerror> event handler is stripped (parity vector)', () => {
  const out = renderNote('<img src="x.png" onerror="alert(1)" alt="safe">');
  assertAbsent(out, 'onerror', 'onerror attr');
  assertPresent(out, 'alt="safe"', 'safe attr kept');
});

test('onclick attribute is stripped', () => {
  const out = renderNote('<span onclick="evil()">text</span>');
  assertAbsent(out, 'onclick', 'onclick attr');
  assertPresent(out, 'text', 'content kept');
});

// Parity vector: javascript: URL blocked by both gates.
// markdown-it's validateLink refuses to create a link at all; the syntax is
// rendered as literal text.  The dangerous case — href="javascript:" — must
// not appear.
test('Markdown [link](javascript:…) produces no javascript: href (parity vector)', () => {
  const out = renderNote('[click](javascript:alert(1))');
  assertAbsent(out, 'href="javascript:', 'javascript href');
  assertPresent(out, 'click', 'link text kept');
});

test('raw HTML <a href="javascript:…"> href is stripped', () => {
  const out = renderNote('<a href="javascript:void(0)">click</a>');
  assertAbsent(out, 'javascript:', 'javascript scheme');
  assertPresent(out, 'click', 'link text kept');
});

test('raw HTML <a href="data:text/html,…"> href is stripped', () => {
  const out = renderNote('<a href="data:text/html,<h1>xss</h1>">link</a>');
  assertAbsent(out, 'data:text/html', 'data: html href');
  assertPresent(out, 'link', 'link text kept');
});

// Parity vector: data:image/svg+xml rejected by both DOMPurify (client hook)
// and bluemonday (server DataImageRaster pattern excludes SVG).
// Use base64 to avoid literal '<' inside the attribute value confusing
// markdown-it's inline-HTML parser.
test('data:image/svg+xml on <img src> is stripped (parity vector)', () => {
  // data:image/svg+xml;base64,PHN2Zz48L3N2Zz4= = <svg></svg>
  const svgData = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  const out = renderNote(`<img src="${svgData}" alt="ok">`);
  assertAbsent(out, 'data:image/svg+xml', 'svg data uri');
});

test('<iframe> is stripped', () => {
  const out = renderNote('<iframe src="https://evil.example.com"></iframe>');
  assertAbsent(out, 'iframe', 'iframe tag');
  assertAbsent(out, 'evil.example.com', 'iframe src');
});

test('<form> and non-checkbox <input> are stripped', () => {
  const out = renderNote('<form action="https://evil.example.com"><input type="submit"></form>');
  assertAbsent(out, '<form', 'form tag');
  assertAbsent(out, '<input', 'submit input tag');
});

test('raw <input type="text"> is stripped (only task-list checkboxes survive)', () => {
  const out = renderNote('<input type="text" value="x">');
  assertAbsent(out, '<input', 'text input tag');
});

// ---------------------------------------------------------------------------
// Allow-listed elements — safe embedded HTML must survive
// ---------------------------------------------------------------------------

test('<details>/<summary> survive', () => {
  const out = renderNote('<details><summary>Click me</summary>hidden body</details>');
  assertPresent(out, '<details', 'details tag');
  assertPresent(out, '<summary>', 'summary tag');
  assertPresent(out, 'hidden body', 'body content');
});

test('<sub> survives', () => {
  const out = renderNote('H<sub>2</sub>O');
  assertPresent(out, '<sub>', 'sub tag');
  assertPresent(out, '2', 'subscript text');
});

// <div> is not in ALLOWED_TAGS (neither gate allows it), but DOMPurify keeps
// text content by default (KEEP_CONTENT=true for non-dangerous tags).
test('<div> text content survives even though the tag is stripped', () => {
  const out = renderNote('<div>hello world</div>');
  assertAbsent(out, '<div', 'div tag stripped');
  assertPresent(out, 'hello world', 'text content kept');
});

test('safe <a href="https://…"> survives', () => {
  const out = renderNote('<a href="https://example.com">link text</a>');
  assertPresent(out, 'href="https://example.com"', 'https href');
  assertPresent(out, 'link text', 'anchor text');
});

test('safe Markdown [link](https://…) survives', () => {
  const out = renderNote('[visit](https://example.com)');
  assertPresent(out, 'href="https://example.com"', 'https href');
  assertPresent(out, 'visit', 'link text');
});

test('safe <img src="https://…"> survives', () => {
  const out = renderNote('<img src="https://example.com/img.jpg" alt="test">');
  assertPresent(out, 'src="https://example.com/img.jpg"', 'https src');
  assertPresent(out, 'alt="test"', 'alt attr');
});

test('mailto: link survives', () => {
  const out = renderNote('[email](mailto:user@example.com)');
  assertPresent(out, 'mailto:user@example.com', 'mailto href');
});

// ---------------------------------------------------------------------------
// Built-in Lucide icons — rendered inline as <svg> so they inherit the note's
// text colour (stroke="currentColor"), instead of a grey <img>.
// ---------------------------------------------------------------------------

test('a Lucide icon image renders inline as <svg stroke="currentColor">', () => {
  const out = renderNote('![search](/api/v1/icons/lucide/search)');
  assertPresent(out, '<svg', 'inline svg emitted');
  assertPresent(out, 'lucide-search', 'icon class kept');
  assertPresent(out, 'currentColor', 'stroke inherits foreground');
  assertAbsent(out, '<img', 'no img element');
  assertAbsent(out, '/api/v1/icons/lucide/search', 'no icon URL left');
});

test('a basepath-prefixed / absolute icon src is still inlined', () => {
  const rel = renderNote('![x](/notes/api/v1/icons/lucide/star)');
  assertPresent(rel, 'lucide-star', 'basepath-prefixed src inlined');
  const abs = renderNote('![x](https://host.example/api/v1/icons/lucide/star)');
  assertPresent(abs, 'lucide-star', 'absolute src inlined');
});

test('an unknown icon name falls back to an <img>', () => {
  const out = renderNote('![x](/api/v1/icons/lucide/no-such-icon)');
  assertPresent(out, '<img', 'unknown icon stays an img');
  assertPresent(out, '/api/v1/icons/lucide/no-such-icon', 'src preserved');
  assertAbsent(out, '<svg', 'no svg for unknown icon');
});

test('an ordinary image is untouched (not treated as an icon)', () => {
  const out = renderNote('![pic](https://example.com/photo.png)');
  assertPresent(out, '<img', 'ordinary image stays an img');
  assertPresent(out, 'src="https://example.com/photo.png"', 'src preserved');
});

test('in-app /notes/slug relative link survives', () => {
  const out = renderNote('[note](/notes/my-note)');
  assertPresent(out, 'href="/notes/my-note"', 'relative href');
});

// ---------------------------------------------------------------------------
// Linkify — bare URLs and email addresses are auto-linked and survive
// ---------------------------------------------------------------------------

test('bare http:// URL is auto-linked and anchor survives', () => {
  const out = renderNote('http://x.test');
  assertPresent(out, '<a', 'autolink anchor');
  assertPresent(out, 'http://x.test', 'URL preserved');
  assertAbsent(out, 'javascript:', 'no js injection');
});

test('bare https:// URL is auto-linked and anchor survives', () => {
  const out = renderNote('visit https://example.com for details');
  assertPresent(out, 'href="https://example.com"', 'https autolink href');
});

test('email address is auto-linked as mailto: and anchor survives', () => {
  // linkify-it requires at least two characters in the domain label; use a
  // realistic address rather than a contrived single-char one.
  const out = renderNote('user@example.com');
  assertPresent(out, '<a', 'autolink anchor');
  assertPresent(out, 'mailto:', 'mailto scheme');
  assertPresent(out, 'user@example.com', 'address in output');
});

// ---------------------------------------------------------------------------
// data: URI per-tag scoping
// ---------------------------------------------------------------------------

// Canonical 1×1 raster fixtures (same constants as xss-gate.test.mjs).
const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GIF_DATA = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Parity vector: data:image/png on img src allowed by both gates (DataImageRaster).
test('data:image/png on <img src> is preserved (parity vector)', () => {
  const out = renderNote(`<img src="${PNG_DATA}" alt="ok">`);
  assertPresent(out, PNG_DATA, 'png data uri on img');
});

test('data:image/gif on <img src> is preserved', () => {
  const out = renderNote(`<img src="${GIF_DATA}" alt="ok">`);
  assertPresent(out, GIF_DATA, 'gif data uri on img');
});

// Parity vector: data:image/svg+xml on img src rejected by both gates.
// Base64 avoids literal '<' breaking markdown-it's HTML tag parser.
test('data:image/svg+xml on <img src> is stripped (parity vector)', () => {
  const svgData = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  const out = renderNote(`<img src="${svgData}" alt="ok">`);
  assertAbsent(out, 'data:image/svg+xml', 'svg data uri on img');
});

// Per-tag scoping: data: is only allowed on img@src, not on a@href.
// DOMPurify's uponSanitizeAttribute hook strips any data: value not
// matching the raster-img exemption — including raster data: on <a href>.
test('data:image/png on <a href> is stripped (per-tag scoping)', () => {
  const out = renderNote(`<a href="${PNG_DATA}">link</a>`);
  assertAbsent(out, 'data:image/png', 'data: href stripped');
  assertPresent(out, 'link', 'link text kept');
});

test('data:text/plain on <img src> is stripped (per-tag scoping)', () => {
  const out = renderNote('<img src="data:text/plain,hello" alt="x">');
  assertAbsent(out, 'data:text/plain', 'text data uri on img');
});

// ---------------------------------------------------------------------------
// Shared server/client parity vectors
// ---------------------------------------------------------------------------
// These inputs document what both the client (DOMPurify via renderNote) and the
// server (bluemonday validateMarkdownStructure) must agree on.  The client
// assertions below are authoritative; the Go counterparts live in
// internal/service/markdown_test.go.  Divergences (where DOMPurify is stricter
// than bluemonday) are noted per-case; the inverse (server stricter) is not
// represented here.

const PARITY_VECTORS = [
  {
    label: 'parity: <script> stripped by both gates',
    md: '<script>alert("parity")</script>',
    absent: ['<script', 'alert("parity")'],
    present: [],
    // Server: validateMarkdownStructure rejects (embedded HTML with <script>).
  },
  {
    label: 'parity: on* event handlers stripped by both gates',
    md: '<b onmouseover="evil()">bold</b>',
    absent: ['onmouseover', 'evil()'],
    present: ['bold'],
    // Server: bluemonday strips all on* attrs; bold text passes through.
  },
  {
    label: 'parity: javascript: link href stripped by both gates',
    md: '<a href="javascript:alert(1)">safe text</a>',
    absent: ['javascript:'],
    present: ['safe text'],
  },
  {
    label: 'parity: data:image/svg+xml on img stripped by both gates',
    // base64 avoids literal '<' inside the attribute value confusing markdown-it.
    md: '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="x">',
    absent: ['data:image/svg+xml'],
    present: [],
    // DOMPurify hook explicitly strips svg data URI; server DataImageRaster
    // excludes svg.
  },
  {
    label: 'parity: data:image/png on img allowed by both gates',
    md: `<img src="${PNG_DATA}" alt="ok">`,
    absent: [],
    present: [PNG_DATA],
    // Both allow the canonical raster MIME set on img@src.
  },
  {
    label: 'parity: http Markdown link survives both gates',
    md: '[visit](http://example.com)',
    absent: [],
    present: ['href="http://example.com"', 'visit'],
    // Server: http is an allowed link scheme (checkScheme).
    // Client: http: matches ALLOWED_URI_REGEXP.
  },
];

for (const { label, md, absent, present } of PARITY_VECTORS) {
  test(label, () => {
    const out = renderNote(md);
    for (const pat of absent)  assertAbsent(out,  pat, label);
    for (const pat of present) assertPresent(out, pat, label);
  });
}

// ---------------------------------------------------------------------------
// GFM task lists — "- [ ]" / "- [x]" render as disabled checkboxes
// ---------------------------------------------------------------------------

test('task-list items render disabled checkboxes with GitHub classes', () => {
  const out = renderNote('- [ ] todo\n- [x] done');
  assertPresent(out, 'type="checkbox"', 'checkbox input');
  assertPresent(out, 'disabled', 'disabled attr');
  assertPresent(out, 'contains-task-list', 'list class');
  assertPresent(out, 'task-list-item', 'item class');
  assertPresent(out, 'todo', 'unchecked item text');
  assertPresent(out, 'done', 'checked item text');
});

test('checked task-list item ([x]) carries the checked attribute', () => {
  const out = renderNote('- [x] done');
  assertPresent(out, 'checked', 'checked attr for [x]');
});

test('unchecked task-list item ([ ]) is not checked', () => {
  const out = renderNote('- [ ] todo');
  assertAbsent(out, 'checked', 'no checked attr for [ ]');
});

test('the "[ ]"/"[x]" marker is consumed, not shown as literal text', () => {
  const out = renderNote('- [ ] buy milk');
  assertAbsent(out, '[ ]', 'literal marker removed');
  assertPresent(out, 'buy milk', 'label preserved');
});

test('a non-task list item is left as an ordinary bullet', () => {
  const out = renderNote('- plain item');
  assertAbsent(out, 'type="checkbox"', 'no checkbox for plain item');
  assertAbsent(out, 'contains-task-list', 'no task-list class');
  assertPresent(out, 'plain item', 'item text');
});

// ---------------------------------------------------------------------------
// Mermaid diagrams — the ```mermaid fenced block must survive rendering as a
// <code class="language-mermaid"> placeholder for the client-side renderer
// (util/mermaid.ts) to turn into SVG after insertion. The SVG rendering itself
// needs a real browser (getBBox), so only the synchronous placeholder is tested
// here.
// ---------------------------------------------------------------------------

test('a ```mermaid block renders a language-mermaid code placeholder', () => {
  const out = renderNote('```mermaid\nflowchart TD\n  A --> B\n```');
  assertPresent(out, '<code class="language-mermaid">', 'mermaid code class');
  assertPresent(out, 'flowchart TD', 'diagram source preserved');
});

test('markup inside a ```mermaid block stays inert (escaped, not executed)', () => {
  const out = renderNote('```mermaid\n<script>alert(1)</script>\n```');
  assertAbsent(out, '<script', 'no live script tag');
  assertPresent(out, '&lt;script&gt;', 'source is HTML-escaped inside <code>');
});

// ---------------------------------------------------------------------------
// Internal note wikilinks — [[slug]] / [[slug|label]]
// ---------------------------------------------------------------------------
// base resolves to '' under jsdom (no <base href>), so hrefs are /notes/<slug>.

test('[[slug]] renders a link to /notes/<slug> with slug text', () => {
  const out = renderNote('See [[my-note]] for details.');
  assertPresent(out, 'href="/notes/my-note"', 'note link href');
  assertPresent(out, '>my-note<', 'default slug text');
});

test('[[slug|label]] uses the alias as the link text', () => {
  const out = renderNote('[[my-note|My Note]]');
  assertPresent(out, 'href="/notes/my-note"', 'aliased href');
  assertPresent(out, '>My Note<', 'alias text');
});

test('[[slug]] does not link to /tags', () => {
  const out = renderNote('[[work]]');
  assertPresent(out, 'href="/notes/work"', 'note href');
  assertAbsent(out, 'href="/tags', 'no tag link for note wikilink');
});

test('non-matching [[…]] is left as literal text (uppercase, spaces)', () => {
  const upper = renderNote('[[UPPER]]');
  assertAbsent(upper, 'href="/notes', 'uppercase slug not linked');
  assertPresent(upper, '[[UPPER]]', 'uppercase left literal');

  const spaced = renderNote('[[Foo Bar]]');
  assertAbsent(spaced, 'href="/notes', 'spaced slug not linked');
  assertPresent(spaced, '[[Foo Bar]]', 'spaced left literal');
});

test('[[slug]] inside a code span stays literal (no link)', () => {
  const out = renderNote('`[[my-note]]`');
  assertAbsent(out, 'href="/notes/my-note"', 'no link inside code span');
  assertPresent(out, '[[my-note]]', 'literal text inside code');
});

// ---------------------------------------------------------------------------
// Internal tag links — [[#slug]] / [[#slug|label]]
// ---------------------------------------------------------------------------
// base resolves to '' under jsdom (no <base href>), so hrefs are /tags/<slug>.

test('[[#slug]] renders a link to /tags/<slug> with #slug text', () => {
  const out = renderNote('See [[#work]] for details.');
  assertPresent(out, 'href="/tags/work"', 'tag link href');
  assertPresent(out, '>#work<', 'default #slug text');
});

test('[[#slug]] accepts hyphenated slugs', () => {
  const out = renderNote('[[#project-x]]');
  assertPresent(out, 'href="/tags/project-x"', 'hyphenated slug href');
});

test('[[#slug|label]] uses the alias as the link text', () => {
  const out = renderNote('[[#work|My Work]]');
  assertPresent(out, 'href="/tags/work"', 'aliased href');
  assertPresent(out, '>My Work<', 'alias text');
  assertAbsent(out, '#work', 'default text replaced by alias');
});

test('non-matching [[#…]] is left as literal text (uppercase, spaces)', () => {
  const upper = renderNote('[[#UPPER]]');
  assertAbsent(upper, 'href="/tags', 'uppercase slug not linked');
  assertPresent(upper, '[[#UPPER]]', 'uppercase left literal');

  const spaced = renderNote('[[#Foo Bar]]');
  assertAbsent(spaced, 'href="/tags', 'spaced slug not linked');
  assertPresent(spaced, '[[#Foo Bar]]', 'spaced left literal');
});

test('[[#slug]] inside a code span stays literal (no link)', () => {
  const out = renderNote('`[[#work]]`');
  assertAbsent(out, 'href="/tags/work"', 'no link inside code span');
  assertPresent(out, '[[#work]]', 'literal text inside code');
});

test('invalid slug is not turned into a tag link, and DOMPurify still gates raw HTML', () => {
  // The '"' breaks the slug charset, so the tag rule declines to match and the
  // input is processed as ordinary Markdown/HTML. The rule itself never emits
  // anything but a link_open with an href attr, so it can't inject markup; the
  // <img> here is authored raw HTML (allowed) with onerror stripped by DOMPurify.
  const out = renderNote('[[#a"><img src=x onerror=alert(1)>]]');
  assertAbsent(out, 'href="/tags', 'no tag link created from an invalid slug');
  assertAbsent(out, 'onerror', 'event handler stripped');
});

test('#fragment refs in SVG are unaffected by the tag rule', () => {
  const out = renderNote('<svg><rect fill="url(#grad)"/></svg>');
  assertPresent(out, 'url(#grad)', 'svg fragment ref preserved');
  assertAbsent(out, 'href="/tags', 'no spurious tag link');
});

test('ATX heading starting with # is unaffected', () => {
  const out = renderNote('# Heading');
  assertPresent(out, '<h1>', 'heading rendered');
  assertAbsent(out, 'href="/tags', 'no spurious tag link');
});

// ---------------------------------------------------------------------------
// AsciiMath math — $inline$ / $$display$$ render to sanitized MathML
// ---------------------------------------------------------------------------

test('inline $…$ renders inline MathML', () => {
  const out = renderNote('Energy $x^2$ here.');
  assertPresent(out, '<math display="inline"', 'inline math element');
  assertPresent(out, '<msup>', 'superscript structure');
  assertPresent(out, '<mn>2</mn>', 'exponent');
});

test('inline $$…$$ on one line renders display MathML', () => {
  const out = renderNote('See $$a/b$$ inline.');
  assertPresent(out, '<math display="block"', 'display math element');
  assertPresent(out, '<mfrac>', 'fraction structure');
});

test('block $$…$$ spanning lines renders a display MathML block', () => {
  const out = renderNote('Before\n\n$$\nsum_(i=1)^n i\n$$\n\nafter');
  assertPresent(out, '<math display="block"', 'display math element');
  assertPresent(out, '<munderover>', 'sum with bounds');
  assertPresent(out, 'after', 'trailing paragraph still rendered');
});

test('single-line $$…$$ as its own block renders display MathML', () => {
  const out = renderNote('$$x+1$$');
  assertPresent(out, '<math display="block"', 'display math element');
});

// Currency must not be swallowed as an (empty) math span: a closing '$' directly
// followed by a digit cannot close, and an opening '$' before whitespace cannot open.
test('currency like "$5 and $10" stays literal text', () => {
  const out = renderNote('I paid $5 and $10 today.');
  assertAbsent(out, '<math', 'no math element for currency');
  assertPresent(out, '$5 and $10', 'dollar amounts preserved');
});

test('escaped \\$ is a literal dollar, not a math delimiter', () => {
  const out = renderNote('Escaped \\$x\\$ literal.');
  assertAbsent(out, '<math', 'no math element for escaped dollars');
  assertPresent(out, '$x$', 'literal dollars preserved');
});

test('an unpaired $ is left as literal text', () => {
  const out = renderNote('Price is $ and more.');
  assertAbsent(out, '<math', 'no math element');
  assertPresent(out, '$ and more', 'lone dollar preserved');
});

test('$…$ inside a code span stays literal (no math)', () => {
  const out = renderNote('`$x^2$`');
  assertAbsent(out, '<math', 'no math element inside code span');
  assertPresent(out, '$x^2$', 'literal text inside code');
});

// The library entity-escapes '<','>','&' and DOMPurify is the final gate, so an
// HTML/script payload smuggled inside math cannot inject active content.
test('script payload inside $…$ cannot inject markup', () => {
  const out = renderNote('$text(<script>alert(1)</script>)$ end');
  assertAbsent(out, '<script', 'no script tag');
  assertAbsent(out, 'alert(1)', 'no script content');
});

test('malformed AsciiMath degrades to a <merror> node, not a render failure', () => {
  const out = renderNote('$sqrt($');
  assertPresent(out, '<math', 'math element still produced');
  assertPresent(out, '<merror>', 'error node for bad input');
});

// ---------------------------------------------------------------------------
// rawHtmlBlockSeparator — blank line before a wiki link inserted after raw HTML
// ---------------------------------------------------------------------------

const SVG_MULTI = '<svg viewBox="0 0 10 10">\n  <rect x="0" y="0" width="10" height="10"/>\n</svg>';
const MATH_MULTI = '<math>\n  <mrow><mi>x</mi></mrow>\n</math>';
const DIV_MULTI = '<div class="x">\n  hello\n</div>';
const COMMENT_MULTI = '<!-- a\n  b -->';

function hasNoteLink(md) {
  return renderNote(md).includes('href="/notes/my-note"');
}

// For each raw HTML block, a link placed at the end WITHOUT a separator is
// swallowed (rendered literally); the separator the helper returns must both be
// non-empty and, once applied, make the link render.
for (const [label, before] of [
  ['multi-line SVG', SVG_MULTI],
  ['multi-line MathML', MATH_MULTI],
  ['multi-line div block', DIV_MULTI],
  ['multi-line HTML comment', COMMENT_MULTI],
]) {
  test(`wiki link swallowed by ${label} without a blank line`, () => {
    assert.ok(!hasNoteLink(before + '[[my-note]]'), `${label}: link should be literal without separator`);
    const sep = rawHtmlBlockSeparator(before);
    assert.ok(sep.length > 0, `${label}: separator should be non-empty`);
    assert.ok(hasNoteLink(before + sep + '[[my-note]]'), `${label}: link should render with separator`);
  });
}

test('separator uses a single newline when the block already ends in one', () => {
  assert.equal(rawHtmlBlockSeparator(SVG_MULTI + '\n'), '\n');
  assert.ok(hasNoteLink(SVG_MULTI + '\n' + '\n' + '[[my-note]]'));
});

test('no separator when a blank line already ends the raw HTML block', () => {
  assert.equal(rawHtmlBlockSeparator(SVG_MULTI + '\n\n'), '');
});

test('no separator after single-line raw HTML (parsed inline, not a block)', () => {
  const single = '<svg viewBox="0 0 1 1"><rect/></svg>';
  assert.equal(rawHtmlBlockSeparator(single), '');
  assert.ok(hasNoteLink(single + '[[my-note]]'), 'single-line SVG does not swallow the link');
});

test('no separator in prose, including a paragraph opened by an inline tag', () => {
  assert.equal(rawHtmlBlockSeparator('hello world'), '');
  assert.equal(rawHtmlBlockSeparator(''), '');
  // A wrapped paragraph starting with an inline tag is not a raw HTML block.
  assert.equal(rawHtmlBlockSeparator('<b>hi</b> some\nmore words'), '');
});
