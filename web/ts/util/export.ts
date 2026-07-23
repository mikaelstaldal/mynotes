import { api, type Note } from '../api/client.js';
import { renderNote } from './markdown.js';
import { renderMermaidBlocks } from './mermaid.js';

// Client-side "Download HTML" / print support.
//
// Reusing the same render pipeline as the on-screen read view: renderNote()
// (markdown-it + DOMPurify, which already converts AsciiMath to MathML and
// inlines Lucide icons as <svg>) followed by renderMermaidBlocks() (diagrams
// to sanitized SVG). Internal artifact images are then inlined as data: URLs
// so the downloaded file renders standalone, without a live server.

// A small, self-contained stylesheet embedded in every exported document so a
// downloaded note renders close to the web UI's read view without a live server.
// Element-level (the body is the raw rendered Markdown fragment); ported from the
// server's exportStylesheet, plus a rule to center Mermaid diagrams. Colors are
// wired to prefers-color-scheme (a standalone file can't read the app's runtime
// data-theme attribute).
const EXPORT_STYLESHEET = `
:root {
  --bg: #ffffff;
  --fg: #1f2937;
  --muted: #6b7280;
  --border: #e5e7eb;
  --primary: #2563eb;
  --surface: #f9fafb;
  --callout-blue: #2563eb;
  --callout-green: #16a34a;
  --callout-cyan: #0891b2;
  --callout-amber: #d97706;
  --callout-red: #dc2626;
  --callout-gray: #6b7280;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111827;
    --fg: #f3f4f6;
    --muted: #9ca3af;
    --border: #374151;
    --primary: #3b82f6;
    --surface: #1f2937;
    --callout-blue: #3b82f6;
    --callout-green: #22c55e;
    --callout-cyan: #22d3ee;
    --callout-amber: #f59e0b;
    --callout-red: #ef4444;
    --callout-gray: #9ca3af;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 65ch;
  padding: 2rem 1.25rem;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.7;
}
body > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { margin: 1.25em 0 0.5em; line-height: 1.3; }
h1 { font-size: 1.75rem; }
h2 { font-size: 1.4rem; }
h3 { font-size: 1.15rem; }
p { margin: 0.75em 0; }
ul, ol { padding-left: 1.5rem; margin: 0.75em 0; }
li + li { margin-top: 0.25em; }
li > p { margin: 0; }
li > p + p { margin-top: 0.75em; }
li:has(input[type="checkbox"]) { list-style: none; }
input[type="checkbox"] { margin: 0 0.4em 0 -1.3em; vertical-align: middle; }
a { color: var(--primary); }
a[href*="/tags/"] {
  text-decoration: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 0.5em;
  font-size: 0.9em;
  white-space: nowrap;
}
pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.9rem 1rem;
  overflow-x: auto;
  font-size: 0.875rem;
  line-height: 1.5;
}
code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.1em 0.35em;
  font-size: 0.875em;
}
pre code { background: none; border: none; padding: 0; font-size: inherit; }
blockquote {
  margin: 0.75em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--border);
  color: var(--muted);
}
.callout {
  --callout-accent: var(--callout-gray);
  margin: 0.75em 0;
  padding: 0.6em 1em;
  border: 1px solid color-mix(in srgb, var(--callout-accent) 35%, var(--border));
  border-left: 4px solid var(--callout-accent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--callout-accent) 8%, var(--bg));
  color: var(--fg);
}
.callout-color-blue { --callout-accent: var(--callout-blue); }
.callout-color-green { --callout-accent: var(--callout-green); }
.callout-color-cyan { --callout-accent: var(--callout-cyan); }
.callout-color-amber { --callout-accent: var(--callout-amber); }
.callout-color-red { --callout-accent: var(--callout-red); }
.callout-color-gray { --callout-accent: var(--callout-gray); }
.callout-para { color: var(--callout-accent); }
.callout-title {
  display: flex;
  align-items: center;
  gap: 0.4em;
  margin: 0;
  font-weight: 600;
  color: var(--callout-accent);
}
.callout-title svg.lucide { vertical-align: middle; }
.callout > :nth-child(2) { margin-top: 0.4em; }
.callout > :last-child { margin-bottom: 0; }
.callout-foldable > .callout-title { cursor: pointer; list-style: none; }
.callout-foldable > .callout-title::-webkit-details-marker { display: none; }
.callout-foldable > .callout-title::after {
  content: "";
  width: 0.5em;
  height: 0.5em;
  margin-left: auto;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(-45deg);
}
details.callout-foldable[open] > .callout-title::after { transform: rotate(45deg); }
/* On paper a collapsed <details> would hide its body; reveal every callout's
   content (and drop the now-meaningless disclosure arrow) so nothing is lost in
   print. Two collapse models are in play: older engines hide the non-summary
   children (display:none), newer ones (Chromium's ::details-content) hide the
   content via content-visibility — override both. */
@media print {
  details.callout > :not(summary) { display: block !important; }
  details.callout::details-content { content-visibility: visible !important; }
  .callout-foldable > .callout-title::after { display: none; }
}
table { border-collapse: collapse; width: 100%; margin: 0.75em 0; }
th, td { border: 1px solid var(--border); padding: 0.4rem 0.7rem; text-align: left; }
th { background: var(--surface); font-weight: 600; }
img { max-width: 100%; height: auto; }
svg.lucide, img[src*="/api/v1/icons/"] { vertical-align: text-bottom; }
.mermaid-diagram { margin: 0.9rem 0; text-align: center; }
.mermaid-diagram svg { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
`;

// Matches an internal artifact image URL and captures its hex SHA-256, anchored
// on the path suffix so it matches root-relative, basepath-prefixed, or absolute
// references (mirrors the server's artifactSrcPattern).
const ARTIFACT_SRC_RE = /(?:^|\/)api\/v1\/artifacts\/([0-9a-f]{64})$/;

// Cap the raw size of an inlined artifact; a larger one becomes a placeholder so
// the download stays a sane size (mirrors the server's maxInlineImageBytes).
const MAX_INLINE_IMAGE_BYTES = 16 << 20; // 16 MiB

// Placeholder spliced in for an artifact too large to embed (mirrors the
// server's brokenImageSVG).
const BROKEN_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><title>Broken image (too large to embed)</title><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" y1="13.5" x2="6" y2="21"/><line x1="18" y1="12" x2="21" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

// Replace internal artifact <img> references with inlined data (base64 for any
// image type — an SVG loaded via <img src="data:"> cannot execute script, so it
// stays inert). Unknown/unresolvable references are left as-is, matching the
// server export.
async function inlineArtifactImages(container: HTMLElement): Promise<void> {
  const imgs = Array.from(container.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      const path = (img.getAttribute('src') ?? '').replace(/[?#].*$/s, '');
      const m = ARTIFACT_SRC_RE.exec(path);
      if (!m) return;
      let art;
      try {
        art = await api.artifacts.get(m[1]);
      } catch {
        return; // leave the reference untouched on failure
      }
      if (!art) return;
      if (art.blob.size > MAX_INLINE_IMAGE_BYTES) {
        img.outerHTML = BROKEN_IMAGE_SVG;
        return;
      }
      img.setAttribute('src', await blobToDataUrl(art.blob));
    }),
  );
}

// Drop the redundant xmlns declaration from every embedded <svg>. The document
// is served/opened as text/html, where the HTML parser already places <svg> in
// the SVG namespace, so the attribute is superfluous (Lucide icons, embedded
// note SVG, and Mermaid output all carry it). Applied after all SVG has been
// spliced in (icons, diagrams, and any broken-image placeholder).
function stripSvgXmlns(container: HTMLElement): void {
  for (const svg of container.querySelectorAll('svg')) {
    svg.removeAttribute('xmlns');
  }
}

// Render a note to a complete, standalone HTML document string: the read-view
// render plus Mermaid diagrams, with internal artifact images inlined.
async function buildDocument(note: Note): Promise<string> {
  const container = document.createElement('div');
  container.innerHTML = renderNote(note.content); // DOMPurify-sanitized
  // mermaid.render() attaches its own measurement node to document.body, so the
  // container itself need not be in the document.
  await renderMermaidBlocks(container);
  await inlineArtifactImages(container);
  stripSvgXmlns(container);
  return (
    '<!DOCTYPE html>\n<html lang="en">\n<head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(note.title)}</title><style>${EXPORT_STYLESHEET}</style></head>\n<body>\n` +
    container.innerHTML +
    '</body>\n</html>\n'
  );
}

// Fetch a note and return its standalone HTML document (used by the print flow).
export async function noteHtmlDocument(slug: string): Promise<string> {
  return buildDocument(await api.notes.get(slug));
}

// Fetch a note, build its standalone HTML document, and trigger a download.
export async function downloadNoteHtml(slug: string): Promise<void> {
  const note = await api.notes.get(slug);
  const html = await buildDocument(note);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${note.slug}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
