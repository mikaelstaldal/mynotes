// node:test coverage for the base-path re-rooting in web/ts/util/markdown.ts
// (exercised via its compiled output, web/static/util/markdown.js).  Run via
// build.sh or directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/basepath.test.mjs
//
// This needs a file of its own: basepath.ts reads <base href> once, at module
// load, so a document that HAS one cannot be arranged inside markdown.test.mjs,
// which deliberately has none (base === '' there, the root deployment).
//
// What is under test is what a subpath deployment does to an internal API
// reference stored root-relative — the form the demo seed content and any
// imported note carry. Without re-rooting, the browser resolves /api/v1/... at
// the origin root, outside the deployment: on the published GitHub Pages demo
// (/mynotes/) that is both a 404 and outside the service worker's scope, so the
// demo's own images cannot load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// jsdom must be installed in globalThis BEFORE markdown.js is evaluated:
// DOMPurify detects its own environment (reads `window`) at module-load time,
// and basepath.js reads the <base href> below at its own load time.
const { JSDOM } = await import(path.resolve(__dirname, 'vendor/test/jsdom.js'));
const { window } = new JSDOM('<!doctype html><html><head><base href="/mynotes/"></head><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;

const { renderNote } = await import(path.resolve(__dirname, '../static/util/markdown.js'));

const SHA = 'a'.repeat(64);

// Parses rendered output so attributes are compared as values, not substrings.
function parse(html) {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  return doc.body;
}

function srcOf(markdown) {
  return parse(renderNote(markdown)).querySelector('img')?.getAttribute('src');
}

// ---------------------------------------------------------------------------
// Artifact images
// ---------------------------------------------------------------------------

test('a root-relative artifact image is re-rooted on the base path', () => {
  assert.equal(srcOf(`![logo](/api/v1/artifacts/${SHA})`), `/mynotes/api/v1/artifacts/${SHA}`);
});

test('an artifact image already carrying the base path is left alone', () => {
  assert.equal(srcOf(`![logo](/mynotes/api/v1/artifacts/${SHA})`), `/mynotes/api/v1/artifacts/${SHA}`);
});

test('an absolute artifact URL is left alone', () => {
  const src = `https://notes.example.com/api/v1/artifacts/${SHA}`;
  assert.equal(srcOf(`![logo](${src})`), src);
});

test('a raw <img> reaching the render gate is re-rooted too', () => {
  assert.equal(srcOf(`<img src="/api/v1/artifacts/${SHA}" alt="logo">`),
    `/mynotes/api/v1/artifacts/${SHA}`);
});

test('an image outside the API namespace is untouched', () => {
  assert.equal(srcOf('![photo](/photos/cat.png)'), '/photos/cat.png');
  assert.equal(srcOf('![remote](https://example.com/cat.png)'), 'https://example.com/cat.png');
});

test('a data: image survives re-rooting unchanged', () => {
  const src = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(srcOf(`![dot](${src})`), src);
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test('a root-relative artifact link is re-rooted on the base path', () => {
  const a = parse(renderNote(`[file](/api/v1/artifacts/${SHA})`)).querySelector('a');
  assert.equal(a.getAttribute('href'), `/mynotes/api/v1/artifacts/${SHA}`);
  assert.equal(a.hasAttribute('target'), false, 'still an internal link');
});

test('an external link keeps its href and opens in a new tab', () => {
  const a = parse(renderNote('[site](https://example.com/)')).querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://example.com/');
  assert.equal(a.getAttribute('target'), '_blank');
});

test('a wiki link is built on the base path', () => {
  const a = parse(renderNote('[[my-note]]')).querySelector('a');
  assert.equal(a.getAttribute('href'), '/mynotes/notes/my-note');
});

// ---------------------------------------------------------------------------
// Icons — matched by path suffix, so both forms already render inline
// ---------------------------------------------------------------------------

test('a built-in icon renders inline in either form', () => {
  for (const src of ['/api/v1/icons/lucide/star', '/mynotes/api/v1/icons/lucide/star']) {
    const body = parse(renderNote(`![star](${src})`));
    assert.ok(body.querySelector('svg.lucide-star'), `${src}: expected inline <svg>`);
    assert.equal(body.querySelector('img'), null, `${src}: expected no <img>`);
  }
});

test('an unknown icon name falls back to a re-rooted <img>', () => {
  assert.equal(srcOf('![nope](/api/v1/icons/lucide/definitely-not-an-icon)'),
    '/mynotes/api/v1/icons/lucide/definitely-not-an-icon');
});
