import DOMPurify from 'dompurify';
import type { Mermaid } from 'mermaid';

// Mermaid diagram rendering for the note read-view and the editor preview.
//
// A ```mermaid fenced code block (Obsidian convention) survives Markdown
// rendering + the DOMPurify gate in markdown.ts as
//   <pre><code class="language-mermaid">…escaped source…</code></pre>
// (class is allow-listed; the source is HTML-escaped text). Mermaid rendering
// is async and needs live DOM, so it can't run inside the synchronous
// renderNote() string pipeline — instead renderMermaidBlocks() runs over the
// container *after* the HTML has been inserted into the DOM (see NoteView and
// NoteEditor's preview effect).
//
// The Mermaid engine is large and only needed when a note actually contains a
// diagram, so it is lazy-imported on first use rather than bundled into the
// initial app load.

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  // Dynamic import of the local ./vendor/mermaid.js (import-map specifier
  // "mermaid"); fine under CSP script-src 'self'. Cached after the first call.
  // The dynamic-import namespace picks up a synthetic-default union under Node16
  // resolution, so pin the shape explicitly; at runtime m.default is the Mermaid
  // object (the bundle re-exports mermaid's default).
  mermaidPromise ??= import('mermaid').then(
    (m) => (m as unknown as { default: Mermaid }).default,
  );
  return mermaidPromise;
}

// A dedicated DOMPurify instance for Mermaid's SVG output. The default instance
// (configured globally in markdown.ts) intentionally strips <style>, the style
// attribute, and <foreignObject> — all of which Mermaid needs — and because it
// was set up with setConfig(), per-call config is ignored. A separate instance
// keeps its own config, so we allow the SVG profile plus the <style>/style that
// Mermaid inlines for theming, while still dropping scripts and on* handlers.
// (DOMPurify sanitizes the CSS inside <style>/style.) This is defense-in-depth:
// Mermaid's securityLevel:'strict' already sanitizes labels with its own
// bundled DOMPurify; this is a second gate on the produced markup.
const svgPurify = DOMPurify(window);
svgPurify.setConfig({
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['style'],
  ADD_ATTR: ['style'],
});

// Monotonic id source for the SVG root Mermaid requires. Not Math.random (which
// is disallowed in some contexts and needlessly non-deterministic); a counter
// is enough to keep ids unique within the document.
let diagramSeq = 0;

// Map the app theme (document root data-theme) onto a Mermaid built-in theme.
function currentMermaidTheme(): 'dark' | 'default' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
}

// Find, render, and replace every unprocessed ```mermaid block inside `container`.
// Each block is processed at most once (guarded by a data-attribute set before
// the first await). A malformed diagram degrades to its original source with an
// error hint rather than throwing, so a note always renders.
export async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  if (blocks.length === 0) return;

  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
    // Re-initialize each run so a theme change (light/dark toggle) takes effect.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: currentMermaidTheme(),
      // Never let Mermaid inject its own full-screen "bomb" error graphic into
      // the DOM; we handle failures ourselves (see below).
      suppressErrorRendering: true,
      // Render node labels as SVG <text>, not HTML <foreignObject> (which our
      // SVG sanitizer strips, leaving empty boxes). Both flags are required —
      // the flowchart-level one alone is not honored by Mermaid 11.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
  } catch (e) {
    // Engine couldn't load/initialize: leave the blocks as plain code rather
    // than throwing (the call sites fire-and-forget). Reset the cache so a
    // later render can retry.
    mermaidPromise = null;
    console.error('Mermaid failed to load', e);
    return;
  }

  await Promise.all(
    Array.from(blocks, async (code) => {
      const pre = code.parentElement;
      if (!pre || pre.dataset.mermaidProcessed) return;
      pre.dataset.mermaidProcessed = 'true';
      const source = code.textContent ?? '';

      // Validate before rendering. In the editor the preview re-runs on every
      // (debounced) keystroke, so the source is frequently an incomplete
      // diagram — parse() with suppressErrors returns false instead of throwing.
      // Leave such a block as plain code rather than flashing an error while the
      // user is still typing.
      let valid = false;
      try {
        valid = Boolean(await mermaid.parse(source, { suppressErrors: true }));
      } catch {
        valid = false;
      }
      if (!valid) return;

      try {
        const { svg } = await mermaid.render(`mermaid-${++diagramSeq}`, source);
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-diagram';
        wrapper.innerHTML = svgPurify.sanitize(svg);
        // If the container's HTML was replaced mid-render (e.g. a fast preview
        // update), `pre` is detached and replaceWith() is a no-op — harmless.
        pre.replaceWith(wrapper);
      } catch {
        // Parsed but failed to render: leave the source visible, flagged so CSS
        // can mark it as failed.
        pre.classList.add('mermaid-error');
      }
    }),
  );
}
