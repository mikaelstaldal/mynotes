// node:test coverage for the demo backend's pure logic (web/ts/demo/*.ts,
// exercised via its compiled output in web/static/demo/).  Run via build.sh or
// directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/demo.test.mjs
//
// The demo files are classic worker scripts, not ES modules: they declare
// globals that importScripts() shares across one worker scope (see
// web/ts/demo/tsconfig.json).  So the test evaluates them as scripts in this
// process's global scope, exactly as the worker does, and then reads the
// declarations back out of it.
//
// What is covered here is the logic ported from the Go server: slugs,
// excerpts, wikilink extraction, heading splits, frontmatter, download
// re-wrapping, content validation, and search.  The IndexedDB store, the fetch
// routing, and the icon rebuild need a browser and are not exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The subset of demo-sw.ts's importScripts list that carries no browser
// dependency. store.js and icons.js are left out: they reach for indexedDB and
// fetch at call time, which this process does not provide.
const SCRIPTS = ['model.js', 'text.js'];

// Evaluated in this realm rather than a fresh vm context, so the values that
// come back are ordinary arrays and objects that deepEqual can compare.
for (const name of SCRIPTS) {
  const file = path.resolve(__dirname, '../static/demo', name);
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file });
}

// Pull the declarations out of the shared scope. A lexical `const`/`function`
// at the top level of a script is not a property of globalThis, so each has to
// be evaluated by name.
const {
  generateSlug, slugWithSuffix, validateSlug, validateTitle, validateContent,
  plainExcerpt, firstATXHeading, splitByHeadings, extractNoteLinks,
  parseFrontmatter, markdownWithFrontmatter, wrapMarkdown,
  searchTerms, searchNote, isTableDelimiter,
} = vm.runInThisContext(`({
  generateSlug, slugWithSuffix, validateSlug, validateTitle, validateContent,
  plainExcerpt, firstATXHeading, splitByHeadings, extractNoteLinks,
  parseFrontmatter, markdownWithFrontmatter, wrapMarkdown,
  searchTerms, searchNote, isTableDelimiter,
})`);

/** Asserts that fn throws an ApiError with the given status. */
function assertRejects(fn, status, label) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.status, status, `${label}: wrong status`);
    return err;
  }
  assert.fail(`${label}: expected a ${status}`);
}

// ---------------------------------------------------------------------------
// Slugs — parity with service.generateSlug
// ---------------------------------------------------------------------------

test('generateSlug lowercases and hyphenates', () => {
  assert.equal(generateSlug('Hello World'), 'hello-world');
  assert.equal(generateSlug('Q3 Project Roadmap'), 'q3-project-roadmap');
  assert.equal(generateSlug('  Spaces   everywhere  '), 'spaces-everywhere');
  assert.equal(generateSlug('a---b'), 'a-b', 'separator runs collapse');
});

test('generateSlug folds accents and drops other non-ASCII', () => {
  assert.equal(generateSlug('Héllo Wörld! Ünïcode'), 'hello-world-unicode');
  assert.equal(generateSlug('Weekend in Lisbon 🇵🇹'), 'weekend-in-lisbon');
  assert.equal(generateSlug('Math & Diagrams'), 'math-diagrams');
});

test('generateSlug falls back to "note" when nothing survives', () => {
  assert.equal(generateSlug('🎉🎉🎉'), 'note');
  assert.equal(generateSlug('---'), 'note');
});

test('generateSlug truncates to 100 characters without a trailing hyphen', () => {
  const slug = generateSlug('x '.repeat(200));
  assert.ok(slug.length <= 100, `too long: ${slug.length}`);
  assert.ok(!slug.endsWith('-'), slug);
});

test('slugWithSuffix keeps the result within the length limit', () => {
  assert.equal(slugWithSuffix('note', 2), 'note-2');
  const long = slugWithSuffix('a'.repeat(100), 12);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('-12'));
});

test('validateSlug rejects anything outside the API pattern', () => {
  validateSlug('a-valid-slug-9');
  for (const bad of ['Bad Slug', 'trailing-', '-leading', 'double--hyphen', 'UPPER', '']) {
    assertRejects(() => validateSlug(bad), 400, bad);
  }
});

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

test('validateTitle rejects empty, control characters, and over-length', () => {
  validateTitle('A fine title');
  assertRejects(() => validateTitle(''), 400, 'empty');
  assertRejects(() => validateTitle('two\nlines'), 400, 'newline');
  assertRejects(() => validateTitle('x'.repeat(201)), 400, 'too long');
  validateTitle('x'.repeat(200));
});

test('validateContent accepts the Markdown the app produces', () => {
  validateContent('# Heading\n\nText with a [link](https://example.com), an ![img](/api/v1/artifacts/x),\n'
    + 'a [[wikilink]], `code`, <kbd>Ctrl</kbd>, <mark>hi</mark>, and a data image:\n\n'
    + '![d](data:image/png;base64,AAAA)\n');
  validateContent('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>');
  validateContent('<math><mi>a</mi></math>');
  validateContent('- [x] done\n- [ ] todo\n');
});

test('validateContent rejects disallowed HTML and event handlers', () => {
  assertRejects(() => validateContent('<script>alert(1)</script>'), 400, 'script');
  assertRejects(() => validateContent('<iframe src="https://x"></iframe>'), 400, 'iframe');
  assertRejects(() => validateContent('<img src="/x.png" onerror="alert(1)">'), 400, 'onerror');
  assertRejects(() => validateContent('<style>body{}</style>'), 400, 'style');
});

test('validateContent enforces the scheme allow-list', () => {
  assertRejects(() => validateContent('[a](javascript:alert(1))'), 400, 'javascript link');
  assertRejects(() => validateContent('![i](http://example.com/x.png)'), 400, 'http image');
  assertRejects(() => validateContent('[a](//evil.example/)'), 400, 'scheme-relative link');
  assertRejects(() => validateContent('![i](data:image/svg+xml;base64,AAAA)'), 400, 'svg data image');
  assertRejects(() => validateContent('<a href="javascript:x">a</a>'), 400, 'javascript href');
  validateContent('[a](http://example.com) and [b](mailto:x@example.com)');
});

test('validateContent ignores markup inside code', () => {
  validateContent('```\n<script>alert(1)</script>\n```\n');
  validateContent('Inline `<script>` is literal text.');
  validateContent('~~~html\n<iframe></iframe>\n~~~\n');
});

test('validateContent rejects stray control characters but allows tab, CR, LF', () => {
  validateContent('a\tb\r\nc\n');
  assertRejects(() => validateContent('ab'), 400, 'U+0002');
});

// ---------------------------------------------------------------------------
// Excerpts — parity with repository.plainExcerpt
// ---------------------------------------------------------------------------

test('plainExcerpt takes the first non-heading line and strips inline syntax', () => {
  assert.equal(plainExcerpt('# Title\n\nSome **bold** and *italic* text.'),
    'Some bold and italic text.');
  assert.equal(plainExcerpt('# Title\n\n- A ~~struck~~ `code` item'), 'A struck code item');
  assert.equal(plainExcerpt('1. First item'), 'First item');
  assert.equal(plainExcerpt('> Quoted line'), 'Quoted line');
});

test('plainExcerpt strips sub/superscript but leaves lone markers', () => {
  assert.equal(plainExcerpt('C~n~H~2n+2~ is an alkane.'), 'CnH2n+2 is an alkane.');
  assert.equal(plainExcerpt('The 2^nd^ and 3^rd^ items.'), 'The 2nd and 3rd items.');
  assert.equal(plainExcerpt('5 ~ 6 and a ^ b'), '5 ~ 6 and a ^ b');
});

test('plainExcerpt renders links and wikilinks as their text', () => {
  assert.equal(plainExcerpt('See [the docs](https://example.com).'), 'See the docs.');
  assert.equal(plainExcerpt('See [[my-note|My Note]].'), 'See My Note.');
  assert.equal(plainExcerpt('See [[my-note]].'), 'See my-note.');
  assert.equal(plainExcerpt('See [[#work]].'), 'See #work.');
  assert.equal(plainExcerpt('![alt](/x.png) after'), 'after');
});

test('plainExcerpt skips rules, HTML blocks, and tables', () => {
  assert.equal(plainExcerpt('---\n\nText'), 'Text');
  assert.equal(plainExcerpt('<div>\nblock\n</div>\n\nText'), 'Text');
  assert.equal(plainExcerpt('| A | B |\n| --- | --- |\n| 1 | 2 |\n\nText'), 'Text');
  assert.equal(plainExcerpt('<br>\n\nText'), 'Text', 'a void tag needs no closing tag');
});

test('plainExcerpt truncates at 120 code points', () => {
  const out = plainExcerpt('é'.repeat(200));
  assert.equal([...out].length, 121);
  assert.ok(out.endsWith('…'));
});

test('isTableDelimiter needs a pipe', () => {
  assert.ok(isTableDelimiter('| --- | :-: |'));
  assert.ok(isTableDelimiter('---|---'));
  assert.ok(!isTableDelimiter('---'), 'a thematic rule is not a table');
});

// ---------------------------------------------------------------------------
// Headings and splitting — parity with service.splitByHeadings
// ---------------------------------------------------------------------------

test('firstATXHeading skips fenced code', () => {
  assert.equal(firstATXHeading('```\n# Not a heading\n```\n\n# Real Heading\n'), 'Real Heading');
  assert.equal(firstATXHeading('## Closed heading ##'), 'Closed heading');
  assert.equal(firstATXHeading('no headings here'), '');
});

test('splitByHeadings splits at the shallowest level and keeps subheadings nested', () => {
  const sections = splitByHeadings('Preamble\n\n## One\n\na\n\n### Deep\n\nb\n\n## Two\n\nc\n');
  assert.deepEqual(sections.map((s) => s.title), ['One', 'Two']);
  assert.ok(sections[0].body.startsWith('## One'));
  assert.ok(sections[0].body.includes('### Deep'), 'a deeper heading stays in its parent section');
  assert.ok(!sections[0].body.includes('Preamble'), 'the preamble is dropped');
  assert.equal(sections[1].body, '## Two\n\nc');
});

test('splitByHeadings returns nothing when there are no headings', () => {
  assert.deepEqual(splitByHeadings('just text\n'), []);
});

// ---------------------------------------------------------------------------
// Wikilinks — parity with repository.extractNoteLinks
// ---------------------------------------------------------------------------

test('extractNoteLinks returns distinct note targets in first-seen order', () => {
  assert.deepEqual(extractNoteLinks('[[b]] then [[a|Label]] then [[b]]', 'self'), ['b', 'a']);
});

test('extractNoteLinks excludes tag links and self-references', () => {
  assert.deepEqual(extractNoteLinks('[[#work]] and [[self]] and [[other]]', 'self'), ['other']);
});

test('extractNoteLinks ignores wikilinks inside code', () => {
  assert.deepEqual(extractNoteLinks('`[[a]]` and\n```\n[[b]]\n```\n[[c]]', 'self'), ['c']);
});

// ---------------------------------------------------------------------------
// Frontmatter — parity with service.parseFrontmatter
// ---------------------------------------------------------------------------

test('parseFrontmatter reads a YAML block and strips it', () => {
  const { fm, body } = parseFrontmatter(
    '---\ntitle: My Note\nslug: my-note\ndate: 2024-03-05\ntags:\n  - work\n  - "quoted tag"\n---\n# Body\n');
  assert.equal(fm.title, 'My Note');
  assert.equal(fm.slug, 'my-note');
  assert.equal(fm.date, '2024-03-05T00:00:00Z');
  assert.deepEqual(fm.tags, ['work', 'quoted tag']);
  assert.equal(body, '# Body\n');
});

test('parseFrontmatter reads a YAML flow sequence and quoted scalars', () => {
  const { fm } = parseFrontmatter('---\ntitle: "A: colon"\ntags: [a, "b"]\n---\nx\n');
  assert.equal(fm.title, 'A: colon');
  assert.deepEqual(fm.tags, ['a', 'b']);
});

test('parseFrontmatter reads TOML and JSON blocks', () => {
  const toml = parseFrontmatter('+++\ntitle = "T"\nslug = "t"\ntags = ["a", "b"]\ndate = 2024-01-15\n+++\nbody\n');
  assert.equal(toml.fm.title, 'T');
  assert.deepEqual(toml.fm.tags, ['a', 'b']);
  assert.equal(toml.fm.date, '2024-01-15T00:00:00Z');
  assert.equal(toml.body, 'body\n');

  const json = parseFrontmatter('{"title":"J","slug":"j","tags":["x"],"date":"2024-01-15T10:30:00Z"}\n\nbody\n');
  assert.equal(json.fm.title, 'J');
  assert.deepEqual(json.fm.tags, ['x']);
  assert.equal(json.fm.date, '2024-01-15T10:30:00Z');
  assert.equal(json.body, 'body\n');
});

test('parseFrontmatter leaves content without a block untouched', () => {
  const content = '# Just a heading\n\nText.\n';
  const { fm, body } = parseFrontmatter(content);
  assert.equal(fm.title, '');
  assert.equal(body, content);

  // An unterminated block is not frontmatter either.
  assert.equal(parseFrontmatter('---\ntitle: x\n\nbody').body, '---\ntitle: x\n\nbody');
});

// ---------------------------------------------------------------------------
// Download form — parity with service.MarkdownWithFrontmatter
// ---------------------------------------------------------------------------

test('markdownWithFrontmatter round-trips through parseFrontmatter', () => {
  const note = {
    slug: 'my-note',
    title: 'My Note: with punctuation',
    content: '# My Note\n\nBody text.\n',
    createdAt: '2026-01-02T03:04:05Z',
    updatedAt: '2026-01-02T03:04:05Z',
    version: 1,
    tags: ['work', 'reference'],
  };
  const out = markdownWithFrontmatter(note);
  assert.ok(out.startsWith('---\n'));
  assert.ok(out.includes('dialect: mynotes\n'));

  const { fm, body } = parseFrontmatter(out);
  assert.equal(fm.title, note.title);
  assert.equal(fm.slug, note.slug);
  assert.equal(fm.date, note.createdAt);
  assert.deepEqual(fm.tags, note.tags);
  assert.equal(body, note.content);
});

test('markdownWithFrontmatter leaves plain scalars unquoted', () => {
  const out = markdownWithFrontmatter({
    slug: 'plain', title: 'Plain Title', content: '', createdAt: '2026-01-02T03:04:05Z',
    updatedAt: '2026-01-02T03:04:05Z', version: 1, tags: ['work'],
  });
  assert.ok(out.includes('title: Plain Title\n'), out);
  assert.ok(out.includes('    - work\n'), out);
  assert.ok(out.includes('date: "2026-01-02T03:04:05Z"\n'), 'a bare timestamp must stay quoted');
});

test('wrapMarkdown reflows long paragraphs only', () => {
  const long = 'word '.repeat(30).trim();
  const wrapped = wrapMarkdown(long);
  assert.ok(wrapped.includes('\n'), 'a long paragraph is wrapped');
  for (const line of wrapped.split('\n')) assert.ok(line.length <= 80, line);
  assert.equal(wrapped.split('\n').join(' '), long, 'no word is lost or changed');
});

test('wrapMarkdown leaves code, tables, lists, and headings alone', () => {
  const long = 'word '.repeat(30).trim();
  for (const block of [
    '```\n' + long + '\n```',
    '    ' + long,
    '| A | B |\n| --- | --- |\n| ' + long + ' | x |',
    '- ' + long,
    '> ' + long,
    '# ' + long,
    '<div>' + long + '</div>',
  ]) {
    assert.equal(wrapMarkdown(block), block, block.slice(0, 20));
  }
});

test('wrapMarkdown never starts a continuation line with a block opener', () => {
  const openers = ['-', '*', '+', '>', '#', '|', '<', '---', '1.', '```', '~~~', '==='];
  for (const opener of openers) {
    const wrapped = wrapMarkdown(('word '.repeat(40) + opener + ' tail').trim());
    for (const line of wrapped.split('\n').slice(1)) {
      assert.ok(!line.startsWith(opener), `${opener}: continuation line "${line}" opens a block`);
    }
  }
});

// ---------------------------------------------------------------------------
// Search — AND semantics and FTS-style snippets
// ---------------------------------------------------------------------------

const NOTE = {
  id: 1,
  slug: 'sourdough-bread',
  title: 'Sourdough Bread',
  content: '# Sourdough Bread\n\nA reliable everyday loaf with a crisp crust and open crumb.\n',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  version: 1,
  tags: [],
};

test('searchTerms splits on non-alphanumerics and folds case and accents', () => {
  assert.deepEqual(searchTerms('  Héllo, World! '), ['hello', 'world']);
  assert.deepEqual(searchTerms('   '), []);
});

test('searchNote requires every term to match', () => {
  assert.ok(searchNote(NOTE, ['loaf']).matched);
  assert.ok(searchNote(NOTE, ['loaf', 'crumb']).matched);
  assert.ok(!searchNote(NOTE, ['loaf', 'absent']).matched, 'AND, not OR');
  assert.ok(searchNote(NOTE, ['sourdough']).matched, 'a title-only term still matches');
});

test('searchNote marks matches with the FTS5 sentinel characters', () => {
  const { snippet } = searchNote(NOTE, ['crumb']);
  assert.ok(snippet.includes('crumb'), snippet);
  assert.ok(snippet.startsWith('#'), 'a window at the start keeps the text before the first token');
});

test('searchNote scores title matches above content matches', () => {
  const title = searchNote(NOTE, ['sourdough']).score;
  const content = searchNote(NOTE, ['crumb']).score;
  assert.ok(title > content, `${title} should outrank ${content}`);
});

test('searchNote returns no snippet when only the title matched', () => {
  const note = { ...NOTE, content: 'nothing relevant here' };
  const hit = searchNote(note, ['sourdough']);
  assert.ok(hit.matched);
  assert.equal(hit.snippet, '', 'the caller falls back to the plain excerpt');
});
