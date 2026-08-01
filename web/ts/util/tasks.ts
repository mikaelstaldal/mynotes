// Mapping a clicked task-list checkbox back to the note's Markdown source.
//
// The web UI renders clickable checkboxes (renderNote's `interactiveTasks`),
// each carrying the source line its "[ ]"/"[x]" marker sits on. This turns such
// a line number into the one-character edit that flips that marker, so the
// clicked item — and no other — changes, however many the note has.

// A GFM task marker at the head of a list item: any blockquote prefix, the
// bullet or ordered-list marker, then "[ ] " / "[x] ". The bullet is optional
// because an item may open on a bare bullet and carry its marker on the next
// line ("-\n  [ ] todo"), which is the line the renderer hands out. Otherwise as
// strict as the shape the renderer requires to draw a checkbox at all (the
// TASK_MARKER_RE it applies to the item's content, which markdown-it has already
// stripped of the prefix matched here), including the space after the marker.
const TASK_LINE_RE = /^((?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?\[)([ xX])\] /;

// A replacement of `content[from..to)` with `insert` — the shape CodeMirror's
// dispatch takes, so the edit lands in the editor's undo history as an ordinary
// one-character change.
export interface TaskToggle {
  from: number;
  to: number;
  insert: string;
}

// The edit that flips the task marker on `line` (0-based) of `content`, or null
// when that line does not carry the marker the caller expects. `wasChecked` is
// the state the clicked checkbox was rendered with, and the marker found must
// still be in it.
//
// Null is an expected answer, not an error: the line number comes from rendered
// HTML, so it can describe a document that has since moved on (the editor's
// preview lags the document it is rendered from, and a restored draft is not the
// document the read view was showing at all), or not be ours at all (a note's
// embedded HTML may carry a `data-task-line` of its own).
//
// The two checks together are what keep a stale number from flipping the wrong
// item, and neither is sufficient alone. The shape check is about the line —
// note that it judges the line in isolation, so a marker that only looks like a
// task (inside a fenced code block, say) is kept out of reach not by this
// function but by the renderer never emitting a checkbox, and so never a line
// number, for it. The state check is about the item: a line number that has
// come to point at a different task is rejected unless that task happens to be
// in the same state, which is the one gap left — and it flips something the user
// can see is wrong and undo, rather than something they cannot.
export function taskToggleAt(content: string, line: number, wasChecked: boolean): TaskToggle | null {
  if (!Number.isInteger(line) || line < 0) return null;
  const start = lineStart(content, line);
  if (start < 0) return null;
  const m = TASK_LINE_RE.exec(content.slice(start, lineEnd(content, start)));
  if (!m) return null;
  if ((m[2] !== ' ') !== wasChecked) return null;
  const at = start + m[1].length;
  return { from: at, to: at + 1, insert: wasChecked ? ' ' : 'x' };
}

// Line breaks as markdown-it's `normalize` rule counts them — it rewrites CRLF
// and a lone CR to LF before any line numbers are assigned, so all three end
// exactly one line here too.
const LINE_BREAK = /\r\n|\r|\n/g;

// Offset at which the 0-based `line` begins, or -1 if the content has fewer lines.
function lineStart(content: string, line: number): number {
  if (line === 0) return 0;
  const re = new RegExp(LINE_BREAK);
  let seen = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (++seen === line) return m.index + m[0].length;
  }
  return -1;
}

// Offset of the line break ending the line that begins at `start`, or the end of
// the content for the last line.
function lineEnd(content: string, start: number): number {
  const re = new RegExp(LINE_BREAK);
  re.lastIndex = start;
  const m = re.exec(content);
  return m ? m.index : content.length;
}
