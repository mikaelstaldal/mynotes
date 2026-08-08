// Drift guard for the app mark: web/ts/components/Logo.tsx and
// web/static/favicon.svg must stay the same picture. Run via build.sh or:
//   node --test web/ts/logo.test.mjs
//
// Three separate places — Logo.tsx's own header, web/AGENTS.md's logo section,
// and spec/REQUIREMENTS.md — assert that these two files carry the same
// letterform, and until this file existed **nothing enforced it**. The e2e suite
// cannot: it renders the app, where favicon.svg never appears. That made the
// sync a convention held by memory alone, in a repo whose own docs note that the
// e2e suite is only run by somebody remembering to run it. This runs on every
// `./build.sh`, which is the property that matters here.
//
// It guards the letterform ONLY. The two files are deliberately different in two
// ways, both of which this test must tolerate rather than catch:
//
//   * favicon.svg keeps the background <rect> that paints its rounded square;
//     the inline copy drops it, because .brand-logo paints the square in
//     --primary and a second one would be a fixed light-mode blue inside a
//     themed box.
//   * favicon.svg fills the letter `#fff` and spans `0 0 32 32`; the inline copy
//     uses `currentColor` and crops the viewBox to the letter, to clear the
//     shared contract's floor on how much of the glyph box the ink must span.
//
// So: same `d`, and nothing else is compared. If the mark is ever redrawn, both
// files change together and this test is what says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');

// Comments must come out before anything below looks for markup, or the
// assertions read the prose describing the code instead of the code. That is not
// hypothetical: this file's first version asserted `doesNotMatch(/<rect/)` and
// went red against Logo.tsx's own comment saying "the favicon's background
// <rect> is absent here" — the guard reporting a violation it had invented,
// which is the same class of error as a guard that passes while measuring
// nothing, just in the louder direction.
// Handles both file types: `/* */` and `//` for the TSX, `<!-- -->` for the SVG.
// Neither file carries an XML comment today, but the SVG assertions are
// presence checks and a commented-out <rect> would satisfy one.
const stripComments = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// Every `d="…"` in a file, in document order.
function pathData(source, label) {
  const found = [...source.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1].trim());
  // A regex that silently matches nothing would make every assertion below
  // compare undefined against undefined and pass. Fail instead.
  assert.ok(found.length > 0, `${label}: no path data found — has the mark stopped being a <path>?`);
  return found;
}

test('the inline Logo and favicon.svg draw the same letterform', () => {
  const logo = pathData(stripComments(read('web/ts/components/Logo.tsx')), 'Logo.tsx');
  const favicon = pathData(stripComments(read('web/static/favicon.svg')), 'favicon.svg');

  assert.equal(logo.length, 1, 'Logo.tsx should draw the mark with exactly one path');
  assert.equal(favicon.length, 1, 'favicon.svg should draw the letter with exactly one path');
  assert.equal(
    logo[0],
    favicon[0],
    'the mark has been changed in one file and not the other — see web/AGENTS.md',
  );
});

test('the inline Logo inherits its ink and paints no square of its own', () => {
  const src = stripComments(read('web/ts/components/Logo.tsx'));

  // The badge's colour comes from CSS via currentColor; a literal fill would
  // pin the glyph to one theme's colour.
  assert.match(src, /fill="currentColor"/, 'the mark must take its ink from currentColor');
  assert.doesNotMatch(src, /fill="#/, 'the inline copy must not hardcode a colour');

  // .brand-logo paints the rounded square. A <rect> here would draw a second,
  // unthemed one on top of it.
  assert.doesNotMatch(src, /<rect/, 'the inline copy must not carry favicon.svg background rect');

  // Decorative: the label beside it carries the link's accessible name.
  assert.match(src, /aria-hidden="true"/, 'the mark must be aria-hidden');
});

test('favicon.svg still carries its own square and explicit fill', () => {
  const src = stripComments(read('web/static/favicon.svg'));
  // The inverse of the test above — favicon.svg has no CSS to lean on, so the
  // two things the inline copy must NOT have are the two it must keep.
  assert.match(src, /<rect[^>]*rx="6"/, 'favicon.svg must keep its rounded square');
  assert.match(src, /fill="#fff"/, 'favicon.svg must fill the letter explicitly');
});
