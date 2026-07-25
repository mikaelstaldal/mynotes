// Embeddable render host — the entry point of the shared render kit.
//
// Native clients (the Android app, and any future one) render notes by loading
// ../../static/render/index.html in a web view and driving this API, instead of
// re-implementing the MyNotes Markdown dialect in their own language. Everything
// substantive lives in util/markdown.ts and util/mermaid.ts, exactly as used by
// the web UI's read view and editor preview, so the two can never drift.
//
// The kit is assembled for embedding by tools/dist-renderer.sh.
//
// Host contract (all state lives on the page; nothing is returned):
//   MyNotesRender.setTheme(theme, vars?)  — 'light' | 'dark', plus optional CSS
//                                           custom-property overrides
//   MyNotesRender.render(markdown)        — replaces the rendered note; resolves
//                                           once diagrams have been drawn
//
// A host that only speaks strings (Android's evaluateJavascript) calls these
// with JSON-encoded arguments; the Markdown never reaches an HTML parser except
// through renderNote's DOMPurify gate.

import { renderNote } from '../util/markdown.js';
import { renderMermaidBlocks } from '../util/mermaid.js';

const target = document.getElementById('note');
if (!target) throw new Error('render host: missing #note element');
const note = target;

// Kept so setTheme() can re-render: Mermaid bakes its theme colours into the
// generated SVG, so a light/dark switch cannot be done with CSS variables alone
// (the web UI's NoteView does the same on its theme-change event).
let lastMarkdown = '';

async function render(markdown: string): Promise<void> {
  lastMarkdown = markdown;
  note.innerHTML = renderNote(markdown); // DOMPurify-sanitized
  await renderMermaidBlocks(note);
}

function setTheme(theme: 'light' | 'dark', vars?: Record<string, string>): void {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  // Optional per-host overrides of note.css's `:root` variables (e.g. an
  // Android client pushing its Material background/foreground) so the embedded
  // view matches the surrounding app chrome while all other styling stays
  // canonical. Only custom properties are settable, so this cannot inject
  // arbitrary CSS. Overrides are inline styles on the root element and so
  // outrank both themes and persist until replaced — a host that overrides a
  // variable must supply a value for every theme it switches to.
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (name.startsWith('--')) document.documentElement.style.setProperty(name, value);
  }
  if (note.querySelector('.mermaid-diagram, code.language-mermaid')) {
    void render(lastMarkdown);
  }
}

export interface RenderHost {
  render(markdown: string): Promise<void>;
  setTheme(theme: 'light' | 'dark', vars?: Record<string, string>): void;
}

Object.assign(globalThis, { MyNotesRender: { render, setTheme } satisfies RenderHost });
