// node:test coverage for web/ts/util/exporthtml.ts (via its compiled output,
// web/static/util/exporthtml.js). Run via build.sh or directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/exporthtml.test.mjs
//
// Exercises the client-side "Download HTML" export: AsciiMath is rendered to
// MathML (unlike the server endpoint), internal artifact images are inlined with
// the same size limit / broken-image / re-sanitize behaviour as the server, and
// the body is wrapped in the standalone HTML document. The artifact resolver is
// injected so no network is required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// jsdom globals must exist before the module (and the DOMPurify it imports) is
// evaluated. exporthtml.js also uses document.createElement('template') and a
// FileReader for base64 data: URLs.
const { JSDOM } = await import(path.resolve(__dirname, 'vendor/test/jsdom.js'));
const { window } = new JSDOM('');
globalThis.window = window;
globalThis.document = window.document;
globalThis.FileReader = window.FileReader;
// Use jsdom's Blob so blobs created here share the realm of the jsdom FileReader
// the module reads them with (in a real browser both come from one realm).
globalThis.Blob = window.Blob;

const { buildExportHtml } = await import(path.resolve(__dirname, '../static/util/exporthtml.js'));

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

// A resolver over a fixed map: keys are hex SHAs, values { blob, contentType }.
function resolverFor(map) {
  return async (sha) => map[sha] ?? null;
}

function present(out, pat, label) {
  assert.ok(out.includes(pat), `${label}: "${pat}" must appear; got:\n${out}`);
}
function absent(out, pat, label) {
  assert.ok(!out.includes(pat), `${label}: "${pat}" must NOT appear; got:\n${out}`);
}

// ---------------------------------------------------------------------------
// Document scaffolding + AsciiMath
// ---------------------------------------------------------------------------

test('wraps the body in a complete standalone HTML document', async () => {
  const out = await buildExportHtml({ title: 'My Note', content: 'Hello world' }, resolverFor({}));
  present(out, '<!DOCTYPE html>', 'doctype');
  present(out, '<title>My Note</title>', 'title element');
  present(out, '<style>', 'embedded stylesheet');
  present(out, 'Hello world', 'rendered body');
});

test('escapes HTML metacharacters in the <title>', async () => {
  const out = await buildExportHtml({ title: 'a < b & "c"', content: 'x' }, resolverFor({}));
  present(out, '<title>a &lt; b &amp; "c"</title>', 'escaped title');
});

test('renders AsciiMath $…$ to MathML (unlike the server export)', async () => {
  const out = await buildExportHtml({ title: 't', content: 'Energy $x^2$ here.' }, resolverFor({}));
  present(out, '<math', 'math element');
  present(out, '<msup>', 'superscript structure');
  absent(out, '$x^2$', 'no literal math source left');
});

test('renders display $$…$$ block math to display MathML', async () => {
  const out = await buildExportHtml({ title: 't', content: '$$sum_(i=1)^n i$$' }, resolverFor({}));
  present(out, 'display="block"', 'display math');
  present(out, 'math[display="block"]', 'stylesheet covers display math');
});

// ---------------------------------------------------------------------------
// Artifact inlining
// ---------------------------------------------------------------------------

test('inlines a raster artifact as a base64 data: URL', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
  const out = await buildExportHtml(
    { title: 't', content: `![pic](/api/v1/artifacts/${SHA})` },
    resolverFor({ [SHA]: { blob, contentType: 'image/png' } }),
  );
  present(out, 'src="data:image/png;base64,', 'raster inlined as data URL');
  absent(out, `/api/v1/artifacts/${SHA}`, 'original artifact URL replaced');
});

test('replaces an oversized raster artifact with the broken-image placeholder', async () => {
  // Only .size is read on the oversized path (no bytes are decoded), so a light
  // stub avoids allocating 16 MiB.
  const blob = { size: (16 << 20) + 1, type: 'image/png' };
  const out = await buildExportHtml(
    { title: 't', content: `![big](/api/v1/artifacts/${SHA})` },
    resolverFor({ [SHA]: { blob, contentType: 'image/png' } }),
  );
  present(out, 'Broken image (too large to embed)', 'broken-image placeholder');
  absent(out, 'data:image/png', 'not embedded');
});

test('splices an SVG artifact in as an inline <svg> element', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const out = await buildExportHtml(
    { title: 't', content: `![d](/api/v1/artifacts/${SHA})` },
    resolverFor({ [SHA]: { blob, contentType: 'image/svg+xml' } }),
  );
  present(out, '<svg', 'inline svg');
  present(out, '<circle', 'svg contents preserved');
  absent(out, `/api/v1/artifacts/${SHA}`, 'img reference replaced');
});

test('leaves an unresolved artifact reference untouched', async () => {
  const out = await buildExportHtml(
    { title: 't', content: `![gone](/api/v1/artifacts/${OTHER_SHA})` },
    resolverFor({}), // resolver returns null
  );
  present(out, `/api/v1/artifacts/${OTHER_SHA}`, 'reference left as-is');
});

test('a resolver failure degrades to leaving the reference, not a thrown export', async () => {
  const out = await buildExportHtml(
    { title: 't', content: `![x](/api/v1/artifacts/${SHA})` },
    async () => { throw new Error('boom'); },
  );
  present(out, `/api/v1/artifacts/${SHA}`, 'reference left as-is on resolver error');
});
