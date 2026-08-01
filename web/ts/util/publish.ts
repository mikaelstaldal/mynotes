import { api, type Note } from '../api/client.js';
import { base } from '../basepath.js';
import { renderNote } from './markdown.js';
import { renderMermaidBlocks } from './mermaid.js';
import { ARTIFACT_SRC_RE, stripSvgXmlns } from './export.js';

// Client-side "Publish" support.
//
// Publishing renders a note here, in the browser, and posts the resulting HTML
// to the server, which serves it at /public/notes/{slug} without
// authentication. The rendering is the client's job because the Markdown
// dialect is defined by this pipeline — renderNote() (markdown-it + DOMPurify,
// which converts AsciiMath to MathML and inlines Lucide icons as <svg>) plus
// renderMermaidBlocks() — and the server has no second implementation of it.
//
// Two things differ from the "Download HTML" path in export.ts, both because a
// published page is served *by* the server rather than standing alone:
//
//   - Images. A download inlines every artifact as a data: URL; a published page
//     references them instead, which keeps the stored HTML small, lets the
//     browser cache each image separately, and lets the same image be shared by
//     several published notes.
//   - Links between notes. A download leaves them pointing at the app, which is
//     right for a file the author opens themselves; a published page points them
//     at the other notes' public pages, which is right for a reader who has no
//     access to the app.

// Rewrite each rendered artifact URL back to the `artifact:<sha256>` reference
// the note content holds, undoing the expansion the DOMPurify hook in
// util/markdown.ts performs at render time.
//
// The server needs the canonical form for two reasons: it is how it discovers
// which artifacts the page makes public, and it is deployment-independent — the
// server expands it to a public artifact URL relative to the published page, so
// a subpath deployment resolves it inside the deployment. Both <img src> and
// SVG <image href> are covered, matching the hook this reverses.
export function restoreArtifactRefs(container: HTMLElement): void {
  for (const img of container.querySelectorAll('img')) {
    const digest = artifactDigest(img.getAttribute('src'));
    if (digest) img.setAttribute('src', `artifact:${digest}`);
  }
  for (const image of container.querySelectorAll('image')) {
    const digest = artifactDigest(image.getAttribute('href'));
    if (digest) image.setAttribute('href', `artifact:${digest}`);
  }
}

function artifactDigest(url: string | null): string | undefined {
  if (url === null) return undefined;
  return ARTIFACT_SRC_RE.exec(url.replace(/[?#].*$/s, ''))?.[1];
}

// The two in-app link targets a wikilink renders to, matched as the exact
// inverse of how util/markdown.ts builds them (`${base}/notes/<slug>` and
// `${base}/tags/<slug>`). Anchoring on the whole value rather than a path
// suffix keeps an external link that merely happens to end in /notes/<something>
// out of it.
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOTE_HREF_RE = new RegExp(`^${escapedBase}/notes/(${SLUG})$`);
const TAG_HREF_RE = new RegExp(`^${escapedBase}/tags/${SLUG}$`);

// Point wikilinks at the public pages of the notes they name, and drop tag
// links.
//
// A rendered wikilink addresses the app (`/notes/<slug>`), which a reader of a
// published page cannot reach — they have no credentials for it. On a published
// page the sibling public page is the right target, and since published pages
// are siblings under /public/notes/, that is just `./<slug>` — relative for the
// same reason the artifact references are (see publicArtifactPrefix in the Go
// service).
//
// The target note is not published as a side effect: a link to a note that is
// not published is simply a link that 404s until it is, which is the accepted
// behaviour. Rewriting unconditionally is what makes it start working the
// moment the target *is* published, with no need to re-publish this note.
//
// A tag link has no public counterpart at all — nothing lists published notes,
// by design — so it would resolve to a password prompt. It is unwrapped to its
// own text, which keeps the tag's name visible while promising nothing.
// Drop any image still pointing into the authenticated API, replacing it with
// its alt text.
//
// Everything the render pipeline emits is meant to be handled before this:
// artifacts become `artifact:` references, and a Lucide icon becomes an inline
// <svg>. But an icon whose name is not in the vendored Lucide bundle — renamed
// upstream, hand-written, or inserted by a client built against a different
// version — falls back to the plain `<img src="${base}/api/v1/icons/lucide/…">`
// rendering, which no reader of a published page can load. A missing icon is a
// small loss; a page that asks unauthenticated readers for credentials is not.
//
// This is a backstop for the whole `/api/v1/` prefix rather than for icons
// specifically, so a future renderer output that reaches the API cannot quietly
// end up on a public page.
export function dropApiImages(container: HTMLElement): void {
  for (const img of Array.from(container.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith(`${base}/api/v1/`)) continue;
    img.replaceWith(img.getAttribute('alt') ?? '');
  }
}

export function rewriteNoteLinks(container: HTMLElement): void {
  for (const a of Array.from(container.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? '';
    const note = NOTE_HREF_RE.exec(href);
    if (note) {
      a.setAttribute('href', `./${note[1]}`);
    } else if (TAG_HREF_RE.test(href)) {
      a.replaceWith(...Array.from(a.childNodes));
    }
  }
}

// Render a note to the HTML fragment the publish endpoint stores: the read-view
// render plus Mermaid diagrams, with artifact images left as references.
//
// The light Mermaid theme is not a parameter: a published page carries no
// script and so cannot switch theme, and the diagram's colours are baked into
// its SVG here, at publish time. Publishing light keeps the diagrams matching
// the page (see web/static/public/page.css).
export async function buildPublishFragment(note: Note): Promise<string> {
  const container = document.createElement('div');
  container.innerHTML = renderNote(note.content); // DOMPurify-sanitized
  // mermaid.render() attaches its own measurement node to document.body, so the
  // container itself need not be in the document.
  await renderMermaidBlocks(container, 'default');
  restoreArtifactRefs(container);
  rewriteNoteLinks(container);
  dropApiImages(container);
  stripSvgXmlns(container);
  return container.innerHTML;
}

// Fetch a note, render it, and publish it. Returns where the page is served,
// relative to the deployment root; callers make it absolute against their own
// base URL (see publicNoteUrl).
export async function publishNote(slug: string): Promise<string> {
  const note = await api.notes.get(slug);
  const published = await api.notes.publish(slug, await buildPublishFragment(note));
  return published.url;
}

// The absolute URL a published note is served at — what a user copies and
// shares. The server returns a root-relative path because it does not know how
// it is reached; the browser does, via <base href>.
export function publicNoteUrl(relativeUrl: string): string {
  return new URL(relativeUrl.replace(/^\//, ''), document.baseURI).href;
}
