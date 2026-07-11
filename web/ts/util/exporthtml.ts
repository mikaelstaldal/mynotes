// Client-side "Download HTML" export.
//
// The server's downloadNoteHtml REST endpoint renders Markdown with goldmark,
// which does NOT understand AsciiMath ($…$ / $$…$$) — it treats the source as
// plain text (and would even mangle math containing Markdown-active runs such as
// `a**b**`). To export documents whose math matches what the reader sees, the
// web UI renders the note here instead, reusing the exact render path used on
// screen (renderNote in util/markdown.ts, which converts AsciiMath to MathML and
// runs the DOMPurify gate), and then reproduces the rest of the server export:
// inlining internal artifact images so the document is standalone, and wrapping
// the body in the same self-contained HTML document + stylesheet.
//
// The server endpoint is retained unchanged for other consumers (e.g. the
// Android app); it simply keeps the literal `$…$` source. Keep this module's
// stylesheet, document template, size limit and broken-image placeholder in sync
// with internal/service/markdown.go (RenderToHTML / exportStylesheet).

import { api } from '../api/client.js';
import { renderNote, sanitizeHtml } from './markdown.js';

// Mirror of internal/service/markdown.go maxInlineImageBytes: a raster artifact
// larger than this is replaced by a placeholder rather than embedded, keeping
// exported documents from ballooning.
const MAX_INLINE_IMAGE_BYTES = 16 << 20; // 16 MiB

// Content types inlined as base64 data: URLs (the raster set the render-time
// policy keeps); anything else that is an artifact image is handled per type
// below (svg/mathml spliced in raw) or left untouched.
const RASTER_RE = /^image\/(png|jpeg|gif|webp)$/i;

// Matches an internal artifact image URL and captures its hex SHA-256, anchored
// on the `/api/v1/artifacts/<sha256>` suffix so it matches root-relative,
// basepath-prefixed and absolute references alike. Mirrors artifactSrcPattern in
// internal/service/markdown.go; any query string or fragment is trimmed first.
const ARTIFACT_SRC_RE = /(?:^|\/)api\/v1\/artifacts\/([0-9a-f]{64})$/;

// Copied verbatim from internal/service/markdown.go brokenImageSVG: uses only
// elements/attributes the sanitize policy permits, so it survives the export's
// re-sanitize pass unchanged.
const BROKEN_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><title>Broken image (too large to embed)</title><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" y1="13.5" x2="6" y2="21"/><line x1="18" y1="12" x2="21" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>`;

// A resolver returns the bytes + content type of the artifact with the given hex
// SHA-256, or null when it is unknown/unavailable (the reference is then left
// as-is). Mirrors the server's ArtifactResolver. Injectable for testing.
export type ArtifactResolver = (sha256: string) => Promise<{ blob: Blob; contentType: string } | null>;

// Small, self-contained stylesheet embedded in every exported document so a
// downloaded note renders close to the web UI's note view without a live server.
// Kept in sync with internal/service/markdown.go exportStylesheet, with an added
// rule for display MathML (mirrors app.css `.note-content math[display="block"]`)
// since — unlike the server export — this one actually emits MathML.
const EXPORT_STYLESHEET = `
:root {
  --bg: #ffffff;
  --fg: #1f2937;
  --muted: #6b7280;
  --border: #e5e7eb;
  --primary: #2563eb;
  --surface: #f9fafb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111827;
    --fg: #f3f4f6;
    --muted: #9ca3af;
    --border: #374151;
    --primary: #3b82f6;
    --surface: #1f2937;
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
table { border-collapse: collapse; width: 100%; margin: 0.75em 0; }
th, td { border: 1px solid var(--border); padding: 0.4rem 0.7rem; text-align: left; }
th { background: var(--surface); font-weight: 600; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
math[display="block"] { display: block; overflow-x: auto; margin: 0.75em 0; text-align: center; }
`;

// Escape text destined for the <title> element (an RCDATA context, so only
// '&' and '<' strictly need escaping; '>' is included for good measure).
function escapeTitle(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Read a Blob as a base64 data: URL (e.g. "data:image/png;base64,…").
function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

// The hex SHA-256 of an internal artifact reference, or null for anything else.
function artifactSHA(src: string | null): string | null {
  if (!src) return null;
  const path = src.split(/[?#]/, 1)[0];
  const m = ARTIFACT_SRC_RE.exec(path);
  return m ? m[1] : null;
}

// Replace internal artifact <img> references so the exported document renders
// standalone: a raster artifact within the size limit becomes a base64 data:
// URL (a larger one is replaced by the broken-image placeholder), and an
// SVG/MathML artifact is spliced in as the raw <svg>/<math> element. Unknown or
// unresolvable references are left untouched. The whole body is re-sanitized
// afterwards (defense-in-depth), mirroring the server export.
async function inlineArtifacts(body: string, resolve: ArtifactResolver): Promise<string> {
  const tpl = document.createElement('template');
  tpl.innerHTML = body; // already sanitized by renderNote; <template> is inert
  for (const img of Array.from(tpl.content.querySelectorAll('img'))) {
    const sha = artifactSHA(img.getAttribute('src'));
    if (!sha) continue;
    let art: { blob: Blob; contentType: string } | null = null;
    try {
      art = await resolve(sha);
    } catch {
      art = null; // treat a failed fetch like an unresolved reference
    }
    if (!art) continue;
    if (RASTER_RE.test(art.contentType)) {
      if (art.blob.size > MAX_INLINE_IMAGE_BYTES) {
        img.outerHTML = BROKEN_IMAGE_SVG;
      } else {
        img.setAttribute('src', await blobToDataURL(art.blob));
      }
    } else if (art.contentType === 'image/svg+xml' || art.contentType === 'application/mathml+xml') {
      img.outerHTML = await art.blob.text();
    }
    // Any other type: leave the <img> as-is.
  }
  return sanitizeHtml(tpl.innerHTML);
}

// Wrap a rendered, sanitized body fragment in a complete standalone HTML
// document. Kept byte-compatible with htmlDocTemplate in
// internal/service/markdown.go.
function wrapDocument(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeTitle(title)}</title><style>${EXPORT_STYLESHEET}</style></head>
<body>
${body}</body>
</html>
`;
}

// Build the complete standalone HTML document for a note, rendering AsciiMath to
// MathML client-side and inlining internal artifact images. resolve is
// injectable for tests; it defaults to the live API.
export async function buildExportHtml(
  note: { title: string; content: string },
  resolve: ArtifactResolver = api.artifacts.get,
): Promise<string> {
  const body = await inlineArtifacts(renderNote(note.content), resolve);
  return wrapDocument(note.title, body);
}

// Trigger a browser download of the given HTML as `<filename>`.
function triggerDownload(filename: string, html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // The app installs a document-level click handler that hijacks in-app anchor
  // navigations (router.ts onRouteChange); a blob: href passes its in-app test,
  // so without this the synthetic click would be preventDefault-ed and pushed to
  // the URL bar instead of downloading. Stop the click at the anchor so it never
  // bubbles to that handler.
  a.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revocation so the download has started; revoking synchronously can
  // abort it in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Render a note to a standalone HTML document (with client-side AsciiMath) and
// download it as `<slug>.html`.
export async function downloadNoteHtml(note: { slug: string; title: string; content: string }): Promise<void> {
  triggerDownload(`${note.slug}.html`, await buildExportHtml(note));
}
