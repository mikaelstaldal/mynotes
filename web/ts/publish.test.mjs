// node:test coverage for web/ts/util/publish.ts (exercised via its compiled
// output, web/static/util/publish.js). Run via build.sh or directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/publish.test.mjs
//
// The point of these tests is the contract with the publish endpoint. The
// fragment posted to it must carry artifact images as canonical
// `artifact:<sha256>` references and nothing else:
//
//   - not the rendered `/api/v1/artifacts/…` URL, which a reader of the public
//     page has no credentials for;
//   - not an inlined `data:` URL, which is what the *download* path produces
//     (util/export.ts) and is explicitly not what publishing does.
//
// The server discovers which artifacts a published page makes public by
// scanning the stored fragment for exactly that reference form, so a rendered
// URL that survives here would silently publish a page with broken images.
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
const { restoreArtifactRefs, rewriteNoteLinks, dropApiImages } =
  await import(path.resolve(__dirname, '../static/util/publish.js'));

const DIGEST = 'a'.repeat(64);
const DIGEST2 = 'b'.repeat(64);

// Renders Markdown the way buildPublishFragment does and applies the reference
// restoration. Mermaid is not exercised here — it needs a browser layout engine
// — so this covers everything the render pipeline produces synchronously.
function publishFragment(markdown) {
  const container = document.createElement('div');
  container.innerHTML = renderNote(markdown);
  restoreArtifactRefs(container);
  rewriteNoteLinks(container);
  dropApiImages(container);
  return container.innerHTML;
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test('an artifact image round-trips back to its artifact: reference', () => {
  const html = publishFragment(`![a picture](artifact:${DIGEST})`);
  assert.match(html, new RegExp(`src="artifact:${DIGEST}"`));
  assert.doesNotMatch(html, /\/api\/v1\/artifacts\//);
  assert.doesNotMatch(html, /data:image/);
});

test('every artifact in a note is restored, not just the first', () => {
  const html = publishFragment(`![one](artifact:${DIGEST})\n\n![two](artifact:${DIGEST2})`);
  assert.match(html, new RegExp(`src="artifact:${DIGEST}"`));
  assert.match(html, new RegExp(`src="artifact:${DIGEST2}"`));
  assert.doesNotMatch(html, /\/api\/v1\/artifacts\//);
});

// The render pipeline resolves `artifact:` on raw <img> in embedded HTML too
// (the expansion lives in a DOMPurify hook, not the markdown-it image rule), so
// the reversal must cover the same ground.
test('an artifact referenced from embedded HTML is restored', () => {
  const html = publishFragment(`<img src="artifact:${DIGEST}" alt="x">`);
  assert.match(html, new RegExp(`src="artifact:${DIGEST}"`));
  assert.doesNotMatch(html, /\/api\/v1\/artifacts\//);
});

test('an artifact referenced from an SVG <image> is restored', () => {
  const html = publishFragment(
    `<svg viewBox="0 0 10 10"><image href="artifact:${DIGEST}" width="10" height="10"/></svg>`);
  assert.match(html, new RegExp(`href="artifact:${DIGEST}"`));
  assert.doesNotMatch(html, /\/api\/v1\/artifacts\//);
});

// ---------------------------------------------------------------------------
// What must be left alone
// ---------------------------------------------------------------------------

test('an external image keeps its URL', () => {
  const html = publishFragment('![remote](https://example.com/pic.png)');
  assert.match(html, /src="https:\/\/example\.com\/pic\.png"/);
});

test('an inline data: image is left inline', () => {
  const src = 'data:image/png;base64,iVBORw0KGgo=';
  const html = publishFragment(`![inline](${src})`);
  assert.match(html, /src="data:image\/png;base64,/);
});

// A Lucide icon renders as an inline <svg>, not as an image request, so the
// published page needs no icon endpoint.
test('a Lucide icon is inlined as svg, not left as a URL', () => {
  const html = publishFragment('![check](/api/v1/icons/lucide/check)');
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /\/api\/v1\/icons\//);
});

// An icon name the vendored Lucide bundle does not carry — renamed upstream,
// hand-written, or written by a client built against another version — falls
// back to a plain <img> at the *authenticated* icon endpoint. A public reader
// cannot load that, so it must not survive onto the page.
test('an unknown icon name does not leave an API image behind', () => {
  const html = publishFragment('![x](/api/v1/icons/lucide/no-such-icon-name)');
  assert.doesNotMatch(html, /\/api\/v1\//);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /x/, 'the alt text stands in for the icon');
});

// ---------------------------------------------------------------------------
// Links between notes
// ---------------------------------------------------------------------------
//
// A rendered wikilink addresses the app (/notes/<slug>), which a reader of a
// published page has no credentials for. On a published page it must address
// the linked note's own public page — a sibling under /public/notes/, hence a
// bare relative "./<slug>". The target is not published as a side effect, so
// such a link may 404 until that note is published too; it starts working then,
// with no need to re-publish the linking note.

test('a wikilink points at the linked note’s public page', () => {
  const html = publishFragment('see [[other-note]]');
  assert.match(html, /href="\.\/other-note"/);
  assert.doesNotMatch(html, /href="[^"]*\/notes\//);
});

test('a labelled wikilink keeps its label', () => {
  const html = publishFragment('see [[other-note|the other one]]');
  assert.match(html, /href="\.\/other-note"/);
  assert.match(html, />the other one</);
});

test('a hand-written link to a note is rewritten too', () => {
  const html = publishFragment('see [the other one](/notes/other-note)');
  assert.match(html, /href="\.\/other-note"/);
});

// The relative form is what makes a stored snapshot survive the deployment
// moving, exactly as the artifact references do.
test('a note link resolves to the sibling public page', () => {
  const html = publishFragment('[[other-note]]');
  const href = /href="([^"]+)"/.exec(html)[1];
  assert.equal(
    new URL(href, 'https://example.com/public/notes/this-note').href,
    'https://example.com/public/notes/other-note',
  );
  // …and equally under a subpath deployment, since nothing is absolute.
  assert.equal(
    new URL(href, 'https://example.com/mynotes/public/notes/this-note').href,
    'https://example.com/mynotes/public/notes/other-note',
  );
});

// Nothing lists published notes, so a tag has no public page and the link would
// resolve to a password prompt. The tag's name still belongs on the page.
test('a tag link is unwrapped to its text', () => {
  const html = publishFragment('filed under [[#recipes]]');
  assert.doesNotMatch(html, /href="[^"]*\/tags\//);
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /#recipes/);
});

test('a labelled tag link keeps its label as text', () => {
  const html = publishFragment('filed under [[#recipes|cooking]]');
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /cooking/);
});

test('an external link is left alone', () => {
  const html = publishFragment('[elsewhere](https://example.com/notes/other-note)');
  assert.match(html, /href="https:\/\/example\.com\/notes\/other-note"/);
});

test('a mailto link is left alone', () => {
  const html = publishFragment('[mail](mailto:someone@example.com)');
  assert.match(html, /href="mailto:someone@example\.com"/);
});

// ---------------------------------------------------------------------------
// The fragment as a whole
// ---------------------------------------------------------------------------

test('a rendered fragment carries no API URLs at all', () => {
  const html = publishFragment([
    '# Heading',
    '',
    `![pic](artifact:${DIGEST})`,
    '',
    '![icon](/api/v1/icons/lucide/star)',
    '',
    'see [[other-note]] and [[#a-tag]]',
    '',
    '> [!warning] Careful',
    '> body',
    '',
    '- [ ] a task',
    '- [x] a done task',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n'));

  assert.doesNotMatch(html, /\/api\/v1\//);
  // Nor any link back into the authenticated app.
  assert.doesNotMatch(html, /href="[^"]*\/(?:notes|tags)\//);
  // …and still contains the things a published page is supposed to show.
  assert.match(html, /<h1/);
  assert.match(html, /callout/);
  assert.match(html, /<table/);
  assert.match(html, /type="checkbox"/);
});

// The publish path renders without interactiveTasks, so checkboxes on a public
// page are inert — there is nobody to record a toggle for.
test('task checkboxes are disabled on a published fragment', () => {
  const html = publishFragment('- [ ] a task');
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /data-task-line/);
});
