// Frontend XSS-gate tests. Run via: node --test web/ts/xss-gate.test.mjs
// Requires vendor/test/node_modules to be unpacked (vendor/test/unpack.sh).
// Imports the real committed vendor bundles so any bundle regression is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The DOMPurify bundle filename carries its version (dompurify-<ver>.js); resolve
// it by glob so this test needn't be edited when the pinned version bumps.
function vendorBundle(prefix) {
  const dir = path.resolve(__dirname, '../static/vendor');
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.js'));
  assert.equal(
    matches.length,
    1,
    `expected exactly one ${prefix}*.js in ${dir}, found ${matches.length}`,
  );
  return path.join(dir, matches[0]);
}

// jsdom must be loaded before any browser-targeting bundle so we can install
// DOM globals before DOMPurify reads `window` at module-evaluation time.
const { JSDOM } = await import(
  path.resolve(__dirname, 'vendor/test/jsdom.js')
);
const { window } = new JSDOM('');
globalThis.window = window;
globalThis.document = window.document;

// Dynamic import: DOMPurify's factory runs after globalThis.window is set.
const { default: DOMPurify } = await import(vendorBundle('dompurify-'));

assert.ok(DOMPurify.isSupported, 'DOMPurify must be supported (jsdom window found)');

// Mirror the config from web/ts/util/markdown.ts exactly.
const DATA_IMAGE_RE = /^data:image\/(gif|png|jpeg|webp);/;

DOMPurify.setConfig({
  ALLOWED_TAGS: [
    'a', 'abbr', 'acronym', 'b', 'blockquote', 'br', 'cite', 'code',
    'dd', 'del', 'dfn', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q',
    's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
    'tt', 'u', 'ul', 'var',
    'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
    'details', 'summary', 'section', 'nav',
    'figure', 'figcaption',
    'img',
  ],
  ALLOWED_ATTR: [
    'href', 'hreflang', 'title', 'alt', 'src', 'height', 'width',
    'cite', 'datetime',
    'abbr', 'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
    'colspan', 'headers', 'rowspan', 'scope', 'span', 'valign',
    'reversed', 'start', 'type',
    'open',
    'dir', 'lang',
  ],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORCE_BODY: true,
});

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'src' && node.tagName === 'IMG' && DATA_IMAGE_RE.test(data.attrValue)) {
    data.keepAttr = true;
    return;
  }
  if (data.attrValue.startsWith('data:')) {
    data.keepAttr = false;
  }
});

// --- data: spike -----------------------------------------------------------

// Canonical 1×1 transparent PNG.
const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('data:image/png;base64 survives on <img src>', () => {
  const out = DOMPurify.sanitize(`<img src="${PNG_DATA}" alt="ok">`);
  assert.ok(out.includes(PNG_DATA), `data:image/png should be kept; got: ${out}`);
});

test('data:image/svg+xml is stripped from <img src>', () => {
  const svgData = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const out = DOMPurify.sanitize(`<img src="${svgData}" alt="ok">`);
  assert.ok(!out.includes('data:image/svg+xml'), `data:image/svg+xml should be stripped; got: ${out}`);
});

test('data:text/html is stripped from <a href>', () => {
  const out = DOMPurify.sanitize('<a href="data:text/html,<h1>xss</h1>">link</a>');
  assert.ok(!out.includes('data:text/html'), `data:text/html href should be stripped; got: ${out}`);
});
