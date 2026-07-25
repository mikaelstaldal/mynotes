// Drift guards for the shared render kit (web/static/render/, assembled for
// native clients by tools/dist-renderer.sh). Run via build.sh or directly:
//   node --test web/ts/render-kit.test.mjs
//
// Nothing here renders Markdown — that is markdown.test.mjs's job. These tests
// cover the wiring that has no other way to fail loudly:
//
//   * The import maps in web/static/index.html and web/static/render/index.html
//     are hand-maintained (web/ts/vendor/rebuild.sh only prints a reminder), so
//     a version bump can leave either pointing at a file that no longer exists,
//     or leave the two pages on different versions of the same library.
//   * The render page's CSP hash covers the exact bytes of its import map. A
//     stray whitespace edit would otherwise break the page silently — in a
//     native client's web view, where there is no server and no console.
//   * tools/dist-renderer.sh copies a hardcoded file list; a renamed or moved
//     module would only surface when someone next vendors the kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const STATIC = path.join(REPO, 'web/static');

const APP_PAGE = 'index.html';
const RENDER_PAGE = 'render/index.html';

const IMPORTMAP_OPEN = '<script type="importmap">';

function readPage(rel) {
  return fs.readFileSync(path.join(STATIC, rel), 'utf8');
}

// Extract the inline import map's raw text exactly as the CSP hash covers it —
// cutting on the FIRST opening tag, mirroring commonweb.ImportMapCSPHash and
// main.go's importMapCSPHash.
function importMapText(html, rel) {
  const open = html.indexOf(IMPORTMAP_OPEN);
  assert.ok(open >= 0, `${rel}: no inline import map`);
  const start = open + IMPORTMAP_OPEN.length;
  const end = html.indexOf('</script>', start);
  assert.ok(end >= 0, `${rel}: unterminated import map`);
  return html.slice(start, end);
}

function importMap(rel) {
  return JSON.parse(importMapText(readPage(rel), rel)).imports;
}

// "../vendor/markdown-it-14.2.0.js" -> "markdown-it-14.2.0.js"
function bundleName(target) {
  return path.basename(target);
}

// "markdown-it-14.2.0.js" -> { name: "markdown-it", version: "14.2.0" }
function splitVersion(file) {
  const m = /^(.*?)-(\d[\w.+-]*)\.(?:module\.)?js$/.exec(file);
  return m ? { name: m[1], version: m[2] } : { name: file, version: null };
}

// --- every import-map target resolves ---------------------------------------

for (const page of [APP_PAGE, RENDER_PAGE]) {
  test(`${page}: every import-map target exists on disk`, () => {
    const imports = importMap(page);
    assert.ok(Object.keys(imports).length > 0, `${page}: empty import map`);
    const pageDir = path.dirname(path.join(STATIC, page));
    for (const [specifier, target] of Object.entries(imports)) {
      const resolved = path.resolve(pageDir, target);
      assert.ok(
        fs.existsSync(resolved),
        `${page}: "${specifier}" -> ${target} does not exist (${resolved}). ` +
          'Update the import map after a vendor version bump — see web/ts/vendor/rebuild.sh.',
      );
    }
  });
}

// --- the two pages agree on shared bundle versions --------------------------

test('index.html and render/index.html pin the same vendor versions', () => {
  const app = importMap(APP_PAGE);
  const render = importMap(RENDER_PAGE);
  const shared = Object.keys(render).filter((s) => s in app);
  assert.ok(shared.length > 0, 'the render page shares no specifier with the app');
  for (const specifier of shared) {
    assert.equal(
      bundleName(render[specifier]),
      bundleName(app[specifier]),
      `"${specifier}" differs between the two import maps; both must reference the same bundle`,
    );
  }
});

test('the render page imports only what the render pipeline needs', () => {
  const specifiers = Object.keys(importMap(RENDER_PAGE)).sort();
  assert.deepEqual(specifiers, [
    'asciimath',
    'dompurify',
    'emoji-data',
    'lucide-icons',
    'markdown-it',
    'mermaid',
  ]);
});

// --- the render page's own CSP hash matches its import map ------------------

test('render/index.html: the meta CSP hash covers its import map', () => {
  const html = readPage(RENDER_PAGE);
  const expected =
    "'sha256-" +
    crypto.createHash('sha256').update(importMapText(html, RENDER_PAGE)).digest('base64') +
    "'";

  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(meta, 'render/index.html: no <meta> Content-Security-Policy');
  const scriptSrc = /script-src ([^;]*)/.exec(meta[1]);
  assert.ok(scriptSrc, 'render/index.html: CSP has no script-src directive');
  assert.ok(
    scriptSrc[1].includes(expected),
    `render/index.html: script-src must contain ${expected} (the hash of the current ` +
      'import map text). The import map was reformatted — update the meta CSP.',
  );
});

// --- dist-renderer.sh's file list still resolves ----------------------------

test('tools/dist-renderer.sh copies files that exist', () => {
  const script = fs.readFileSync(path.join(REPO, 'tools/dist-renderer.sh'), 'utf8');

  const files = /^FILES=\(\n([\s\S]*?)^\)$/m.exec(script);
  assert.ok(files, 'dist-renderer.sh: could not find the FILES array');
  const listed = files[1].split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(listed.length > 0, 'dist-renderer.sh: FILES is empty');
  for (const rel of listed) {
    assert.ok(
      fs.existsSync(path.join(STATIC, rel)),
      `dist-renderer.sh copies web/static/${rel}, which does not exist. ` +
        'Run ./build.sh (tsc output) or fix the list.',
    );
  }

  const prefixes = /^VENDOR_PREFIXES=\(([^)]*)\)$/m.exec(script);
  assert.ok(prefixes, 'dist-renderer.sh: could not find VENDOR_PREFIXES');
  const listedPrefixes = prefixes[1].trim().split(/\s+/);
  const vendorDir = path.join(STATIC, 'vendor');
  for (const prefix of listedPrefixes) {
    const matches = fs.readdirSync(vendorDir).filter((f) => f.startsWith(prefix) && f.endsWith('.js'));
    assert.equal(
      matches.length,
      1,
      `dist-renderer.sh: expected exactly one ${prefix}*.js in web/static/vendor, found ${matches.length}`,
    );
  }

  // The kit must ship every bundle the render page's import map names, or the
  // vendored copy loads a module that isn't there.
  const needed = Object.values(importMap(RENDER_PAGE)).map(bundleName);
  for (const file of needed) {
    const { name } = splitVersion(file);
    assert.ok(
      listedPrefixes.includes(`${name}-`),
      `dist-renderer.sh: VENDOR_PREFIXES is missing "${name}-", needed by render/index.html`,
    );
  }
});
