import DOMPurify from 'dompurify';
import { ALLOWED_URI_REGEXP, isHTTPURL } from './urls.js';
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
  // Dynamic import of the local ./third_party/mermaid-<version>.js (import-map specifier
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
// DOMPurify does not sanitize CSS text; the CSS gate below handles that.
// This is defense-in-depth:
// Mermaid's securityLevel:'strict' already sanitizes labels with its own
// bundled DOMPurify; this is a second gate on the produced markup.
const svgPurify = DOMPurify(window);
svgPurify.setConfig({
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['style'],
  ADD_ATTR: ['style'],
  ALLOWED_URI_REGEXP,
});
svgPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName.toLowerCase() !== 'a') return;
  // SVG anchors can carry either spelling, including both on the same node.
  const hrefs = ['href', 'xlink:href'].map((name) => node.getAttribute(name) ?? '');
  if (hrefs.some((href) => isHTTPURL(href))) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Fail closed on CSS syntax that can escape Mermaid's SVG selector scope or
// load external resources. Inspect inert markup before it reaches the live DOM.
// CSS escapes, comments, non-animation at-rules and nesting are unsupported.
export function sanitizeMermaidSVG(svg: string, id: string): string {
  const template = document.createElement('template');
  template.innerHTML = svgPurify.sanitize(svg);
  const safeValues = (css: string): boolean =>
    !/[\\]|\/\*/.test(css) &&
    !/\b(?:url|image|image-set|-webkit-image-set|cross-fade|src|element)\(/i.test(
      css.replace(/url\(\s*["']?#[\w-]+["']?\s*\)/gi, '')) &&
    !/\bposition\s*:\s*(?:fixed|sticky)\b|\b[\d.]+(?:vw|vh|vmin|vmax|dvw|dvh)\b/i.test(css);
  for (const style of template.content.querySelectorAll('style')) {
    const css = style.textContent ?? '';
    if (!safeValues(css) || /@(?!keyframes\b)/i.test(css)) throw new Error('Unsafe diagram CSS');
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const animations = new Map<string, string>();
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSKeyframesRule) {
        const name = rule.name;
        if (!/^[\w-]+$/.test(name)) throw new Error('Unsafe animation name');
        animations.set(name, `${id}-${name}`);
        rule.name = `${id}-${name}`;
        continue;
      }
      if (!(rule instanceof CSSStyleRule) || rule.cssRules.length > 0 ||
          !rule.selectorText.split(',').every((selector) => {
            const trimmed = selector.trim();
            return (trimmed === `#${id}` || trimmed.startsWith(`#${id} `)) &&
              !/[()~+]/.test(trimmed);
          })) throw new Error('Unscoped diagram CSS');
      if (rule.selectorText.split(',').some((selector) => selector.trim() === `#${id}`) &&
          Array.from(rule.style).some((property) =>
            !['font-family', 'font-size', 'fill', 'color'].includes(property))) {
        throw new Error('Unsafe diagram root CSS');
      }
    }
    // Keyframes have document-wide names even when their users are scoped.
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const property of ['animation', 'animation-name']) {
        const value = rule.style.getPropertyValue(property);
        if (value) rule.style.setProperty(property, value.replace(/[\w-]+/g,
          (name) => animations.get(name) ?? name), rule.style.getPropertyPriority(property));
      }
    }
    // Serialize the parsed, validated rules, never the original CSS text.
    style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
  }
  for (const element of template.content.querySelectorAll('*')) {
    for (const attr of Array.from(element.attributes)) {
      if (/^(style|fill|stroke|filter|clip-path|mask|cursor|marker.*)$/i.test(attr.name) &&
          !safeValues(attr.value)) throw new Error('Unsafe diagram attribute');
    }
  }
  return template.innerHTML;
}

// Monotonic id source for the SVG root Mermaid requires. Not Math.random (which
// is disallowed in some contexts and needlessly non-deterministic); a counter
// is enough to keep ids unique within the document.
let diagramSeq = 0;

export type MermaidTheme = 'dark' | 'default';

// Map the app theme (document root data-theme) onto a Mermaid built-in theme.
function currentMermaidTheme(): MermaidTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
}

// Find, render, and replace every unprocessed ```mermaid block inside `container`.
// Each block is processed at most once (guarded by a data-attribute set before
// the first await). A malformed diagram degrades to its original source with an
// error hint rather than throwing, so a note always renders. `themeOverride`
// forces a specific theme regardless of the live document (used by the HTML
// export and the print path, which bake colours into standalone documents).
export async function renderMermaidBlocks(
  container: HTMLElement,
  themeOverride?: MermaidTheme,
): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  if (blocks.length === 0) return;

  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
    // Re-initialize each run so a theme change (light/dark toggle) takes effect.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize',
        'suppressErrorRendering', 'maxEdges', 'themeCSS', 'themeVariables',
        'fontFamily', 'altFontFamily', 'fontSize', 'htmlLabels'],
      theme: themeOverride ?? currentMermaidTheme(),
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
      // Styling statements reach a temporary live SVG before the output gate.
      // Braces can close Stylis's scope; escapes/comments and resource syntax
      // can hide a declaration or initiate a request before we inspect output.
      // Check styling statements rather than labels or Mermaid's shape syntax.
      const styling = source.match(/\b(?:classDef|style|linkStyle|cssClass)\s+[^\n]*/g) ?? [];
      if (styling.some((line) =>
        /[{}&\\@]|\/\*|:(?:has|is|where)\s*\(|(?:url|image|image-set|cross-fade|src|element)\s*\(/i.test(line))) {
        pre.classList.add('mermaid-error');
        return;
      }

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
        const id = `mermaid-${++diagramSeq}`;
        const { svg } = await mermaid.render(id, source);
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-diagram';
        wrapper.innerHTML = sanitizeMermaidSVG(svg, id);
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
