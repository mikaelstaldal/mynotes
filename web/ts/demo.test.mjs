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
const SCRIPTS = ['model.js', 'text.js', 'api.js'];

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
  validateContent('# Heading\n\nText with a [link](https://example.com), an ![img](artifact:'
    + 'a'.repeat(64) + '),\n'
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
  assertRejects(() => validateContent('![i](artifact:nope)'), 400, 'malformed artifact ref');
  assertRejects(() => validateContent(`[a](artifact:${'a'.repeat(64)})`), 400, 'artifact link');
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
    updatedAt: '2026-01-02T03:04:05Z', tags: ['work'],
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

const { nextNoteTimestamp, nowTimestamp } = vm.runInThisContext('({ nextNoteTimestamp, nowTimestamp })');
test('note timestamps retain milliseconds and strictly increase when the clock repeats or moves backwards', () => {
  assert.match(nowTimestamp(), /\.\d{3}Z$/);
  const stored = '2026-01-02T03:04:05.456Z';
  const instant = Date.parse(stored);
  assert.equal(nextNoteTimestamp(stored, instant), '2026-01-02T03:04:05.457Z');
  assert.equal(nextNoteTimestamp(stored, instant - 1000), '2026-01-02T03:04:05.457Z');
  assert.equal(nextNoteTimestamp(stored, instant + 10), '2026-01-02T03:04:05.466Z');
});

test('frontmatter retains fractional authorship timestamps on export and import', () => {
  const note = { ...NOTE, createdAt: '2026-01-02T03:04:05.456Z' };
  const { fm } = parseFrontmatter(markdownWithFrontmatter(note));
  assert.equal(fm.date, note.createdAt);
});

test('demo PATCH uses timestamp ETags, preserves no-ops, and rejects stale writes', async () => {
  const state = {
    notes: [{ ...NOTE, createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' }],
    tags: [], nextNoteId: 2,
  };
  let writes = 0;
  const context = vm.createContext({
    Request, Response, Headers,
    withStore: async fn => fn(state),
    saveState: async () => { writes++; },
  });
  for (const name of ['model.js', 'text.js', 'api.js']) {
    const file = path.resolve(__dirname, '../static/demo', name);
    vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  }
  const { getNote, patchNote } = vm.runInContext('({ getNote, patchNote })', context);
  const before = await getNote(NOTE.slug);
  const tag = before.headers.get('ETag');
  assert.equal(tag, '"2099-01-01T00:00:00.000Z"');
  assert.equal('version' in await before.json(), false);
  const patch = (content, ifMatch) => patchNote(NOTE.slug, new Request('http://localhost/api/v1/notes/' + NOTE.slug, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': ifMatch },
    body: JSON.stringify({ content }),
  }));
  const noOp = await patch(NOTE.content, tag);
  assert.equal(noOp.headers.get('ETag'), tag);
  assert.equal(writes, 0);
  const changed = await patch('Changed', tag);
  const body = await changed.json();
  assert.equal(body.updated_at, '2099-01-01T00:00:00.001Z');
  assert.equal(changed.headers.get('ETag'), `"${body.updated_at}"`);
  assert.equal(writes, 1);
  await assert.rejects(patch('Stale overwrite', tag), err => err.status === 412);
  assert.equal(state.notes[0].content, 'Changed');
  assert.equal(writes, 1);
});

test('tag and artifact timestamps retain server second precision', () => {
  const { nowMetadataTimestamp } = vm.runInThisContext('({ nowMetadataTimestamp })');
  assert.match(nowMetadataTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('wikilink bounds mirror Go and renderer, including Unicode labels', () => {
  const slug = 'a'.repeat(100);
  const label = '😀'.repeat(256);
  assert.deepEqual(extractNoteLinks(`[[${slug}|${label}]]`, 'self'), [slug]);
  assert.deepEqual(extractNoteLinks(`[[${slug}a]] [[a|${label}界]] [[ok]]`, 'self'), ['ok']);
});

test('malformed wikilink runs extract in bounded time', () => {
  for (const unit of ['[', '[[a|', '[[a', '[[a-']) {
    const start = performance.now();
    assert.deepEqual(extractNoteLinks(unit.repeat(Math.floor(1_000_000 / unit.length)), 'self'), []);
    assert.ok(performance.now() - start < 3000, 'million-character extraction takes under three seconds');
  }
});


test('wikilink label backticks cannot hide following HTML from validation', () => {
  for (const prefix of ['[[x|`]]', '[[#t|`]]']) {
    assertRejects(() => validateContent(prefix + '<img src=x onerror=1>`'), 400, 'wikilink onerror');
    assertRejects(() => validateContent(prefix + '<a href="javascript:x">x</a>`'), 400, 'wikilink URL');
  }
  validateContent('[[x|`<script>]]');
  validateContent('`[[x|label]]<script>`');
});

test('math consumes backticks before code-span validation', () => {
  for (const prefix of ['$`$', 'text $$`$$', '$x\n`$', '$$\n`\n$$\n']) {
    assertRejects(() => validateContent(prefix + '<script>x</script>`'), 400, prefix);
    assertRejects(() => validateContent(prefix + '<span class="dialog-overlay">hi</span>`'), 400, prefix);
  }
  validateContent('$`<script>x</script>`$');
  validateContent('$$\n<script>x</script>\n$$');
});

test('inline math does not cross paragraph boundaries', () => {
  assertRejects(() => validateContent('$x\n\n<script>x</script>\n\nx$'), 400, 'separate paragraphs');
});

test('math markers inside an HTML block do not hide HTML', () => {
  assertRejects(() => validateContent('<div>\n$$\n<script>x</script>'), 400, 'HTML block');
});

test('validateContent rejects ambiguous scheme prefixes in destinations', () => {
  for (const dest of [
    '&#106;avascript:alert(1)', 'javascript&colon;alert(1)',
    'java&#9;script:alert(1)', 'java&#10;script:alert(1)',
    'java&#13;script:alert(1)', String.raw`java\script:alert(1)`,
    String.raw`javascript\:alert(1)`, '&#47;&#47;evil.example/x',
    '/&#47;evil.example/x', String.raw`/\/evil.example/x`,
  ]) {
    for (const content of [
      `[x](${dest})`, `![x](${dest})`,
      `[x][r]\n\n[r]: ${dest}`, `![x][r]\n\n[r]: ${dest}`,
      `[r]\n\n[r]: ${dest}`, `[r][]\n\n[r]: ${dest}`,
    ]) assertRejects(() => validateContent(content), 400, content);
  }
  validateContent('[x](https://example.com/a?x=1&amp;y=2)');
  validateContent('![x](/a&amp;b.png) and [x](./a&amp;b) and [x](#a&amp;b)');
});

test('reference destinations use the allow-list of each use', () => {
  for (const content of [
    '![x][r]\n\n[r]: http://example.com/a.png',
    '[x][r]\n\n[r]: data:image/png;base64,AAAA',
    '[r][]\n\n[r]: artifact:' + 'a'.repeat(64),
  ]) assertRejects(() => validateContent(content), 400, content);
  validateContent('[r]: javascript:alert(1)'); // unused definition
  validateContent('paragraph\n[r]: javascript:alert(1)'); // literal paragraph text
  validateContent('![r]\n\n[r]: artifact:' + 'a'.repeat(64));
  validateContent('[x][R]\n\n[r]: https://example.com');
});


test('validateContent rejects ambiguous foreign title bodies', () => {
  for (const body of [
    '<img src=x onerror=alert(1)>',
    '<iframe srcdoc=x></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<script>alert(1)</script>',
    '<b>safe but ambiguous</b>',
    'x < y',
  ]) {
    for (const fragment of [
      `<div><svg><title>${body}</title></svg></div>`,
      `<div><svg><TITLE>${body}</TITLE></svg></div>`,
      `<div><svg><title/>${body}</svg></div>`,
      `<div><svg><title>${body}`,
      `<div><math><mtext><title>${body}</title></mtext></math></div>`,
    ]) {
      assertRejects(() => validateContent(fragment), 400, fragment);
    }
  }
  validateContent('<div><svg><title>Plain title</title></svg></div>');
  validateContent('<div><svg><title>x &lt; y</title></svg></div>');
  validateContent('<div><svg><title>&lt;img onerror=alert(1)&gt;</title></svg></div>');
});

// The editor and worker are compiled separately, so exercise both entry points.
const { titleFromContent } = await import('../static/util/title.js');

test('editor and demo preserve ATX heading text and closing-marker semantics', () => {
  const bodies = ['', ' ', '\t', '#', '###', ' a ', 'a ##  ', 'a#', 'a # b', '😀\t#', 'a\r', 'a\u2028b'];
  for (const body of bodies) {
    const line = '# ' + body;
    const match = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    const expected = match?.[1].trim() ?? '';
    assert.equal(firstATXHeading(line), expected, JSON.stringify(line));
    assert.equal(titleFromContent(line), expected.replace(/\t/g, ' ') || null, JSON.stringify(line));
  }
  assert.equal(titleFromContent('```\n# hidden\n```\n## Visible ##'), 'Visible');
  assert.equal(titleFromContent('# ' + '😀'.repeat(201)), '😀'.repeat(200) + '…');
});

test('editor and demo scan pathological heading lines in linear time', () => {
  for (const suffix of ['b', '#', '# b']) {
    const line = '# a' + ' '.repeat(200_000) + suffix;
    const start = performance.now();
    assert.equal(titleFromContent(line), suffix === '#' ? 'a' : 'a' + ' '.repeat(199) + '…');
    assert.equal(firstATXHeading(line), suffix === '#' ? 'a' : line.slice(2));
    assert.ok(performance.now() - start < 1000, '200 KB heading takes under one second');
  }
});


test('import tags validate the full list and distinct count before mutation', () => {
  const ensureTags = vm.runInThisContext('ensureTags');
  for (const slugs of [
    ['fresh', 'BAD'],
    Array.from({ length: 51 }, (_, i) => 'tag-' + i),
  ]) {
    const state = { tags: [] };
    assertRejects(() => ensureTags(state, slugs), 400, 'invalid import tags');
    assert.deepEqual(state.tags, []);
  }
  const state = { tags: [] };
  const slugs = Array.from({ length: 50 }, (_, i) => 'tag-' + i);
  ensureTags(state, [...slugs, ...slugs]);
  assert.equal(state.tags.length, 50);
});

test('demo rejects oversized tag arrays and imports before processing', async () => {
  const resolve = vm.runInThisContext('resolveTags');
  const state = { tags: [{ slug: 'known' }] };
  assert.deepEqual(resolve(state, Array(50).fill('known')), ['known']);
  assertRejects(() => resolve(state, Array(51).fill('known')), 400, 'tag cap');
  const importDocument = vm.runInThisContext('importNote');
  for (const type of ['text/html', 'text/markdown']) {
    await assert.rejects(importDocument(new Request('https://demo/api/v1/import', {
      method: 'POST', headers: { 'Content-Type': type }, body: 'é'.repeat(1_000_001),
    }), 'unused'), (err) => err.status === 400 && err.message.includes('import must contain'));
  }
});
