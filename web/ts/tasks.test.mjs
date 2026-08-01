// node:test coverage for web/ts/util/tasks.ts (exercised via its compiled
// output, web/static/util/tasks.js) together with the renderer that produces
// the line numbers it consumes.  Run via build.sh or directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/tasks.test.mjs
//
// The pair is what makes a clicked checkbox flip the right item, so the tests
// below mostly go through both: render with `interactiveTasks`, take a
// checkbox's data-task-line, and check what taskToggleAt does with it.
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
const { taskToggleAt } = await import(path.resolve(__dirname, '../static/util/tasks.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(content, toggle) {
  assert.ok(toggle, 'expected a toggle');
  return content.slice(0, toggle.from) + toggle.insert + content.slice(toggle.to);
}

// What the rendered checkboxes carry — source line and rendered state — in
// document order: exactly what a click hands to taskToggleAt.
function renderedBoxes(markdown) {
  const doc = new JSDOM(renderNote(markdown, { interactiveTasks: true })).window.document;
  return [...doc.querySelectorAll('input[data-task-line]')].map(el => ({
    line: Number(el.getAttribute('data-task-line')),
    checked: el.hasAttribute('checked'),
  }));
}

function renderedLines(markdown) {
  return renderedBoxes(markdown).map(b => b.line);
}

// Flip the nth (0-based) rendered checkbox of `markdown` and return the result.
function clickNth(markdown, n) {
  const boxes = renderedBoxes(markdown);
  assert.ok(n < boxes.length, `note has no task item ${n} (found ${boxes.length})`);
  return apply(markdown, taskToggleAt(markdown, boxes[n].line, boxes[n].checked));
}

// ---------------------------------------------------------------------------
// Toggling
// ---------------------------------------------------------------------------

test('an unchecked item becomes checked and back again', () => {
  const once = clickNth('- [ ] todo', 0);
  assert.equal(once, '- [x] todo');
  assert.equal(clickNth(once, 0), '- [ ] todo');
});

test('an uppercase [X] is cleared like a lowercase one', () => {
  assert.equal(clickNth('- [X] done', 0), '- [ ] done');
});

test('only the clicked item changes when there are several', () => {
  const md = '- [ ] one\n- [ ] two\n- [ ] three\n';
  assert.equal(clickNth(md, 0), '- [x] one\n- [ ] two\n- [ ] three\n');
  assert.equal(clickNth(md, 1), '- [ ] one\n- [x] two\n- [ ] three\n');
  assert.equal(clickNth(md, 2), '- [ ] one\n- [ ] two\n- [x] three\n');
});

test('items are matched through headings, prose and separate lists', () => {
  const md = [
    '# Shopping',
    '',
    'Before leaving:',
    '',
    '* [ ] wallet',
    '',
    '## At the shop',
    '',
    '1. [x] milk',
    '2. [ ] bread',
  ].join('\n');
  assert.ok(clickNth(md, 0).includes('* [x] wallet'), 'bullet item flipped');
  assert.ok(clickNth(md, 1).includes('1. [ ] milk'), 'ordered item cleared');
  assert.ok(clickNth(md, 2).includes('2. [x] bread'), 'second ordered item set');
});

test('a nested item is matched, and its parent is left alone', () => {
  const md = '- [ ] parent\n  - [ ] child\n';
  assert.equal(clickNth(md, 1), '- [ ] parent\n  - [x] child\n');
});

test('an item inside a blockquote is matched', () => {
  const md = '> [!todo] Later\n> - [ ] someday\n';
  assert.equal(clickNth(md, 0), '> [!todo] Later\n> - [x] someday\n');
});

test('an item inside a foldable or boxed callout is matched', () => {
  // Those two rewrite the blockquote they are built from; the marker's line
  // must survive it.
  assert.equal(clickNth('>- Fold\n> - [ ] hidden\n', 0), '>- Fold\n> - [x] hidden\n');
  assert.equal(clickNth('>* Box\n> - [x] shown\n', 0), '>* Box\n> - [ ] shown\n');
});

test('CRLF line endings are counted the way the renderer counts them', () => {
  const md = 'intro\r\n\r\n- [ ] one\r\n- [ ] two\r\n';
  assert.equal(clickNth(md, 1), 'intro\r\n\r\n- [ ] one\r\n- [x] two\r\n');
});

test('a marker on the line after its bullet is matched, not the bullet line', () => {
  // The item begins a line before its marker does, so the line handed out has to
  // be the paragraph's, not the list item's.
  assert.deepEqual(renderedLines('-\n  [ ] todo\n'), [1]);
  assert.equal(clickNth('-\n  [ ] todo\n', 0), '-\n  [x] todo\n');
  assert.equal(clickNth('1.\n   [x] late\n', 0), '1.\n   [ ] late\n');
});

// ---------------------------------------------------------------------------
// A line number that no longer describes the document it is applied to
// ---------------------------------------------------------------------------

test('a marker not in the clicked state is left alone', () => {
  // The clicked box was drawn unchecked; the line is a task but a checked one,
  // so the rendering the click came from no longer describes this document.
  assert.equal(taskToggleAt('- [x] done', 0, false), null, 'unchecked click, checked marker');
  assert.equal(taskToggleAt('- [ ] todo', 0, true), null, 'checked click, unchecked marker');
});

test('a line that has become a different task is only flipped in the same state', () => {
  const before = '- [ ] one\n- [x] two\n';
  // Clicking "two" (line 1, checked) after a line has been added above it: line
  // 1 is now "one", which is unchecked, so nothing happens.
  const shifted = 'new first line\n\n- [ ] one\n- [x] two\n';
  const box = renderedBoxes(before)[1];
  assert.equal(taskToggleAt(shifted, box.line, box.checked), null);
});

// ---------------------------------------------------------------------------
// Lines that carry no task marker — a stale or foreign line number
// ---------------------------------------------------------------------------

test('a line without a task marker yields no toggle', () => {
  for (const [md, line, label] of [
    ['just a paragraph', 0, 'paragraph'],
    ['- plain item', 0, 'ordinary list item'],
    ['- [ ] todo', 1, 'past the end'],
    ['- [ ] todo', -1, 'negative line'],
    ['- [x]\n', 0, 'marker with no text after it'],
  ]) {
    assert.equal(taskToggleAt(md, line, false), null, label);
    assert.equal(taskToggleAt(md, line, true), null, `${label} (clicked checked)`);
  }
});

// taskToggleAt judges a line by its shape alone, so what keeps a "- [ ]" that
// only looks like a task out of reach is the renderer never handing out its
// line number in the first place.
test('a marker in a code fence is never rendered as a checkbox', () => {
  assert.deepEqual(renderedLines('```\n- [ ] not a task\n```\n'), []);
});
