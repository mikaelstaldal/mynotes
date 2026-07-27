// node:test coverage for web/ts/util/emailhtml.ts (exercised via its compiled
// output, web/static/util/emailhtml.js).  Run via build.sh or directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/email.test.mjs
//
// The point of these tests is the contract with MyMail. A note sent as an email
// is sanitized on the way out by MyMail's *outgoing* policy
// (mymail/internal/sanitize.NewOutgoingPolicy), which allows a fixed set of
// elements, no `class`, and a fixed set of CSS properties whose values may not
// contain escapes, comments, or any functional notation but the colour
// functions. That policy is restated below and asserted against the real
// rendered output, so a rule added with — say — `position` or `box-shadow`
// fails here rather than arriving at the recipient stripped.
//
// Keep these lists in sync with mymail/internal/sanitize/sanitize.go. MyMail
// applies the same allowlist in both directions, so what passes here is also
// what a MyMail recipient renders — see that file for why the two match.
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

const { renderNote } = await import(path.resolve(__dirname, '../static/util/markdown.js'));
const { toEmailBody } = await import(path.resolve(__dirname, '../static/util/emailhtml.js'));

const BASE = 'https://example.com/mynotes/';

// ---------------------------------------------------------------------------
// MyMail's outgoing-email policy, restated
// ---------------------------------------------------------------------------

// sanitize.allAllowedElements
const ALLOWED_ELEMENTS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
  'li', 'ol', 'p', 'pre', 's', 'span', 'strong',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  // inert semantic elements
  'abbr', 'caption', 'cite', 'col', 'colgroup', 'dd', 'dfn', 'dl', 'dt',
  'figcaption', 'figure', 'ins', 'kbd', 'mark', 'q', 'samp', 'small',
  'sub', 'sup', 'tt', 'u', 'var',
]);

// sanitize.cssAllowlist
const ALLOWED_CSS_PROPERTIES = new Set([
  'color', 'background-color', 'font-family', 'font-size',
  'font-style', 'font-variant', 'font-weight', 'letter-spacing',
  'line-height', 'text-align', 'text-decoration', 'text-indent',
  'vertical-align', 'white-space', 'word-spacing',
  'border', 'border-color', 'border-style', 'border-width',
  'border-collapse', 'border-spacing',
  'padding', 'margin', 'width', 'max-width', 'height',
  // per-side longhands of the box shorthands above, plus decorative/sizing
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-radius', 'list-style', 'list-style-type', 'list-style-position',
  'min-width', 'min-height', 'max-height',
]);

// bluemonday drops these elements together with their character data, so any
// one of them reaching MyMail means content is lost outright rather than
// degraded — unlike a merely-disallowed element, which is unwrapped.
const CONTENT_DESTROYING = [
  'frame', 'frameset', 'iframe', 'noembed', 'noframes',
  'noscript', 'nostyle', 'object', 'script', 'style', 'title',
];

// sanitize.reHref
const ALLOWED_HREF = /^(https?:\/\/|mailto:)/i;
// sanitize.reSrc
const ALLOWED_SRC =
  /^(https?:\/\/|data:image\/(gif|jpe?g|pjpeg|png|webp|bmp|tiff?|ico|avif|apng|jfif|x-icon|vnd\.microsoft\.icon);base64,[a-zA-Z0-9+/]+={0,2}$)/i;

// sanitize.reAllowedCSSFunc / cssValueAllowed
const ALLOWED_CSS_FUNC = /\b(?:rgb|rgba|hsl|hsla)\([^()]*\)/g;

function cssValueAllowed(value) {
  if (value.includes('\\')) return false;
  if (value.includes('/*') || value.includes('*/')) return false;
  return !/[()]/.test(value.replace(ALLOWED_CSS_FUNC, ''));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build an email body from Markdown, the way buildNoteEmail does.
function emailBodyFromMarkdown(markdown) {
  return emailBodyFromHtml(renderNote(markdown));
}

// Build an email body from an already-rendered fragment. Used for the
// export-only constructs (Mermaid SVG) that the Markdown renderer alone does
// not produce.
function emailBodyFromHtml(html) {
  return buildFromHtml(html).html;
}

// The full result, for the tests that care about what was lost.
function buildFromHtml(html) {
  const fragment = document.createElement('div');
  fragment.innerHTML = html;
  return toEmailBody(fragment, BASE);
}

function buildFromMarkdown(markdown) {
  return buildFromHtml(renderNote(markdown));
}

function parse(bodyHtml) {
  const holder = document.createElement('div');
  holder.innerHTML = bodyHtml;
  return holder;
}

// Assert that everything in `bodyHtml` survives MyMail's policy intact.
function assertSurvivesMymailPolicy(bodyHtml, label) {
  const root = parse(bodyHtml);

  for (const tag of CONTENT_DESTROYING) {
    assert.equal(
      root.querySelectorAll(tag).length, 0,
      `${label}: <${tag}> is dropped with its content by MyMail`,
    );
  }

  for (const el of root.querySelectorAll('[style]')) {
    const tag = el.tagName.toLowerCase();
    assert.ok(
      ALLOWED_ELEMENTS.has(tag),
      `${label}: styled <${tag}> is not allowed by MyMail, so its style is wasted`,
    );
    for (const declaration of el.getAttribute('style').split(';')) {
      if (!declaration.trim()) continue;
      const colon = declaration.indexOf(':');
      assert.ok(colon > 0, `${label}: malformed declaration "${declaration}"`);
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim().toLowerCase();
      assert.ok(
        ALLOWED_CSS_PROPERTIES.has(property),
        `${label}: CSS property "${property}" is not on MyMail's allowlist`,
      );
      assert.ok(
        cssValueAllowed(value),
        `${label}: CSS value "${value}" is rejected by MyMail's validator`,
      );
    }
  }

  for (const anchor of root.querySelectorAll('a[href]')) {
    assert.match(anchor.getAttribute('href'), ALLOWED_HREF, `${label}: href dropped by MyMail`);
  }
  for (const img of root.querySelectorAll('img[src]')) {
    assert.match(img.getAttribute('src'), ALLOWED_SRC, `${label}: img src dropped by MyMail`);
  }
}

// ---------------------------------------------------------------------------
// The policy contract, over a note using every construct the renderer emits
// ---------------------------------------------------------------------------

const KITCHEN_SINK = `
# Heading one

## Heading two

Some *emphasis*, **strong**, \`inline code\` and a [link](https://example.com/x).

- bullet
- [ ] open task
- [x] done task

1. first
2. second

> [!warning] Careful
> Body of the callout.

> [!note]- Foldable
> Hidden body.

> Plain quote

| a | b |
|---|---|
| 1 | 2 |

\`\`\`js
const x = 1;
\`\`\`

Inline math $x^2+1$ and a rule:

---

![image](https://example.com/pic.png)
`;

// KITCHEN_SINK reduced to what the body can carry: no math, no image, and the
// alias callouts swapped for plain boxed quotes (an alias renders a Lucide icon
// in its title, which now counts as a loss).
const KITCHEN_SINK_CARRYABLE = KITCHEN_SINK
  .replace('Inline math $x^2+1$ and a rule:', 'A rule:')
  .replace('![image](https://example.com/pic.png)', '')
  .replace('> [!warning] Careful', '>* Careful')
  .replace('> [!note]- Foldable', '>- Foldable');

test('a note using every construct survives MyMail unchanged', () => {
  assertSurvivesMymailPolicy(emailBodyFromMarkdown(KITCHEN_SINK), 'kitchen sink');
});

test('the styled wrapper carries the page-level typography', () => {
  const root = parse(emailBodyFromMarkdown('hello'));
  const wrapper = root.firstElementChild;
  assert.equal(wrapper.tagName.toLowerCase(), 'div');
  assert.match(wrapper.getAttribute('style'), /line-height:1\.7/);
  assert.match(wrapper.getAttribute('style'), /color:#1f2937/);
});

// ---------------------------------------------------------------------------
// Constructs rewritten because email cannot carry them
// ---------------------------------------------------------------------------

test('Mermaid diagrams become a pointer to the attachment', () => {
  const body = emailBodyFromHtml(
    '<div class="mermaid-diagram"><svg xmlns="http://www.w3.org/2000/svg"><g/></svg></div>',
  );
  assert.equal(parse(body).querySelectorAll('svg').length, 0);
  assert.match(body, /Mermaid diagram/);
  assert.match(body, /<em>/);
  assertSurvivesMymailPolicy(body, 'mermaid');
});

test('Lucide icons are dropped without disturbing their surroundings', () => {
  const body = emailBodyFromHtml('<p>before <svg class="lucide"><path d="M0 0"/></svg> after</p>');
  assert.equal(parse(body).querySelectorAll('svg').length, 0);
  assert.match(parse(body).textContent, /before\s+after/);
});

test('MathML degrades to its text in a code span', () => {
  const body = emailBodyFromMarkdown('Formula $x^2+1$ here.');
  const root = parse(body);
  assert.equal(root.querySelectorAll('math').length, 0);
  const code = root.querySelector('code');
  assert.ok(code, 'expected a <code> stand-in for the formula');
  assert.match(code.textContent, /x/);
  assertSurvivesMymailPolicy(body, 'mathml');
});

test('foldable callouts flatten to an always-expanded box', () => {
  const root = parse(emailBodyFromMarkdown('> [!note]- Title\n> Hidden body.\n'));
  assert.equal(root.querySelectorAll('details').length, 0);
  assert.equal(root.querySelectorAll('summary').length, 0);
  const callout = root.querySelector('blockquote');
  assert.ok(callout, 'expected the callout to survive as a blockquote');
  assert.match(root.textContent, /Hidden body\./, 'the folded body must still be present');
});

test('callouts keep their accent colour on the left edge', () => {
  const root = parse(emailBodyFromMarkdown('> [!warning] Careful\n> Body.\n'));
  const style = root.querySelector('blockquote').getAttribute('style');
  // Neutral border all round, amber accent overriding the left edge. The
  // shorthand must come first or it would reset the accent away — MyMail
  // preserves declaration order (TestDeclarationOrderPreserved pins that).
  assert.match(style, /border:1px solid #e5e7eb/);
  assert.match(style, /border-left:4px solid #d97706/);
  assert.ok(
    style.indexOf('border:') < style.indexOf('border-left:'),
    `shorthand must precede longhand, got: ${style}`,
  );
});

test('task-list items drop their bullet so only the ballot box shows', () => {
  const root = parse(emailBodyFromMarkdown('- [x] done\n'));
  assert.match(root.querySelector('li').getAttribute('style'), /list-style:none/);
});

test('task-list checkboxes become ballot-box characters', () => {
  const root = parse(emailBodyFromMarkdown('- [ ] open\n- [x] done\n'));
  assert.equal(root.querySelectorAll('input').length, 0);
  assert.match(root.textContent, /☐\s*open/);
  assert.match(root.textContent, /☑\s*done/);
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

test('relative links are resolved against the page base', () => {
  const root = parse(emailBodyFromHtml('<p><a href="notes/other">other</a></p>'));
  assert.equal(root.querySelector('a').getAttribute('href'), 'https://example.com/mynotes/notes/other');
});

test('fragment-only links keep their text but lose the href', () => {
  const root = parse(emailBodyFromHtml('<p><a href="#section">jump</a></p>'));
  const anchor = root.querySelector('a');
  assert.equal(anchor.hasAttribute('href'), false);
  assert.equal(anchor.textContent, 'jump');
});

test('mailto links are left alone', () => {
  const root = parse(emailBodyFromHtml('<p><a href="mailto:someone@example.com">mail</a></p>'));
  assert.equal(root.querySelector('a').getAttribute('href'), 'mailto:someone@example.com');
});

test('inlined data: images are preserved as-is', () => {
  const src = 'data:image/png;base64,iVBORw0KGgo=';
  const root = parse(emailBodyFromHtml(`<p><img src="${src}" alt="x"></p>`));
  assert.equal(root.querySelector('img').getAttribute('src'), src);
});

test('an image whose source cannot be made absolute is removed', () => {
  const root = parse(emailBodyFromHtml('<p><img src="cid:whatever" alt="x"></p>'));
  assert.equal(root.querySelectorAll('img').length, 0);
});

// ---------------------------------------------------------------------------
// Degradation reporting — decides whether the standalone export is attached
// ---------------------------------------------------------------------------

// Nothing here can be shown in an email body, so each must be reported and pull
// the attachment in with it.
test('content the body cannot carry is reported', () => {
  const mermaid = '<div class="mermaid-diagram"><svg><g/></svg></div>';
  assert.deepEqual(buildFromHtml(mermaid).degraded, ['diagrams']);
  assert.deepEqual(buildFromMarkdown('Formula $x^2+1$ here.').degraded, ['formulas']);
  assert.deepEqual(buildFromHtml('<p><img src="cid:x" alt="x"></p>').degraded, ['images']);
  assert.deepEqual(
    buildFromHtml('<p><svg viewBox="0 0 1 1"><circle r="1"/></svg></p>').degraded,
    ['embedded graphics'],
  );
  assert.deepEqual(
    buildFromHtml('<p><svg class="lucide"><path d="M0 0"/></svg></p>').degraded,
    ['icons'],
  );
});

test('several losses are reported together, without duplicates', () => {
  const { degraded } = buildFromHtml(
    '<div class="mermaid-diagram"><svg><g/></svg></div>' +
      '<div class="mermaid-diagram"><svg><g/></svg></div>' +
      '<p><img src="cid:x" alt="x"></p>',
  );
  assert.deepEqual(degraded, ['diagrams', 'images']);
});

// The counterpart, and the reason the attachment is conditional: a note built
// from ordinary Markdown is reproduced faithfully, so attaching a second copy of
// it would be pure noise.
test('an ordinary note reports no degradation', () => {
  assert.deepEqual(buildFromMarkdown(KITCHEN_SINK_CARRYABLE).degraded, []);
});

// Each of these is a substitution, not a loss: the same information reaches the
// recipient in a different shape. Reporting them would attach the export to
// almost every note.
test('substitutions are not counted as degradation', () => {
  for (const [name, markdown] of [
    ['task list', '- [x] done\n- [ ] open\n'],
    ['foldable box', '>- Folded\n> Hidden body.\n'],
    ['static box', '>* Careful\n> Body.\n'],
    ['tables', '| a | b |\n|---|---|\n| 1 | 2 |\n'],
    ['code block', '```js\nconst x = 1;\n```\n'],
  ]) {
    assert.deepEqual(buildFromMarkdown(markdown).degraded, [], name);
  }
});

// Icons cannot be shown in an email body, so they are reported like any other
// loss — under their own name, separately from other embedded SVG, so the reader
// is told which of the two went missing. The surrounding text is undisturbed.
test('Lucide icons are reported as a loss', () => {
  const icon = '<p>before <svg class="lucide lucide-info"><path d="M0 0"/></svg> after</p>';
  const { html, degraded } = buildFromHtml(icon);
  assert.deepEqual(degraded, ['icons']);
  assert.equal(parse(html).querySelectorAll('svg').length, 0);
  assert.match(parse(html).textContent, /before\s+after/);
});

// The renderer puts a Lucide icon in the title of every alias callout, so such a
// note travels with the attachment even though nothing else about it degrades.
// This is the main practical consequence of counting icons.
test('alias callouts report their title icon', () => {
  assert.deepEqual(buildFromMarkdown('> [!warning] Careful\n> Body.\n').degraded, ['icons']);
  assert.deepEqual(buildFromMarkdown('> [!note]- Folded\n> Hidden.\n').degraded, ['icons']);
  // The same box written without an alias has no icon and stays attachment-free.
  assert.deepEqual(buildFromMarkdown('>* Careful\n> Body.\n').degraded, []);
});

// A Mermaid diagram is replaced by text pointing at the attachment, so it must
// always be reported — otherwise the body would reference a file that was
// never sent.
test('the diagram placeholder never promises an attachment that is not sent', () => {
  const { html, degraded } = buildFromHtml('<div class="mermaid-diagram"><svg><g/></svg></div>');
  assert.match(html, /attached/);
  assert.ok(degraded.length > 0, 'the placeholder text requires the attachment');
});
