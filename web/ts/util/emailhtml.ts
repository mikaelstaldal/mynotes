// The HTML half of "Send as email": turns an export fragment into a body an
// email can actually carry. Pure DOM manipulation with no I/O, so it is
// exercised directly by web/ts/email.test.mjs.
//
// The rewriting is not belt-and-braces. MyMail sanitizes what it sends with
// `sanitize.OutgoingHTML` (internal/sanitize.NewOutgoingPolicy): it drops
// <style> elements along with their content, drops `class`, and allows only a
// fixed set of elements and CSS properties. Anything not expressed the way this
// module expresses it simply does not reach the recipient — which is also
// roughly how real mail clients behave, so the two constraints point the same
// way. The .html attachment sent alongside (see email.ts) is what makes the
// loss recoverable.
//
// That outgoing policy is deliberately wider than the one MyMail applies to
// untrusted inbound mail; the per-side CSS longhands and `border-radius` used
// below exist there for this path. Do not reach for `position`, `display`,
// `opacity` or a `<style>` element — those are excluded from both policies on
// purpose, and are unreliable in mail clients regardless.

// Light-theme palette, mirroring the :root block of export.ts's
// EXPORT_STYLESHEET. Email always exports light: a mail body is read against the
// client's own background, so a baked-in dark body reads as broken in a light
// client (the same reasoning as the print path).
const FG = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';
const PRIMARY = '#2563eb';
const SURFACE = '#f9fafb';
const MONO = 'ui-monospace,Menlo,Consolas,monospace';

// Callout accent colours by family, and the flat tint that stands in for the
// stylesheet's `color-mix(in srgb, accent 8%, bg)` background. The mix has to be
// pre-computed: MyMail's CSS validator rejects every functional notation except
// the rgb()/hsl() colour functions, so color-mix() would be dropped.
const CALLOUT_ACCENT: Record<string, string> = {
  blue: '#2563eb',
  green: '#16a34a',
  cyan: '#0891b2',
  amber: '#d97706',
  red: '#dc2626',
  gray: '#6b7280',
};
const CALLOUT_TINT: Record<string, string> = {
  blue: '#eef3fd',
  green: '#ecf8f1',
  cyan: '#ebf6f9',
  amber: '#fcf4eb',
  red: '#fceeee',
  gray: '#f3f4f5',
};

// The exported stylesheet, restated as (selector, declarations) pairs applied as
// inline `style=` attributes. Only properties on MyMail's outgoing allowlist
// survive; `color-mix()` and every other functional notation is rejected by its
// value validator, so the callout tints below are pre-computed hex.
//
// Order matters twice over: declarations are appended, so a later rule overrides
// an earlier one for the same property, and within one rule a shorthand must
// precede the longhand that refines it (`border` then `border-left`).
const STYLE_RULES: [selector: string, declarations: string][] = [
  ['h1,h2,h3,h4,h5,h6', 'margin:1.25em 0 0.5em;line-height:1.3;font-weight:600'],
  ['h1', 'font-size:28px'],
  ['h2', 'font-size:22px'],
  ['h3', 'font-size:18px'],
  ['h4,h5,h6', 'font-size:16px'],
  // Callout titles and callout boxes get their own declarations below; excluding
  // them here keeps each style attribute free of overridden duplicates, which
  // matters because every byte is sent to the recipient.
  ['p:not(.callout-title)', 'margin:0.75em 0'],
  ['ul,ol', 'margin:0.75em 0;padding-left:1.5em'],
  ['li', 'margin:0.25em 0'],
  ['li>p', 'margin:0'],
  // The app hides the marker on task items; the ☐/☑ substituted for the
  // checkbox below would otherwise sit next to a redundant bullet.
  ['li.task-list-item', 'list-style:none'],
  ['a', `color:${PRIMARY}`],
  [
    'a[href*="/tags/"]',
    `text-decoration:none;background-color:${SURFACE};border:1px solid ${BORDER};border-radius:999px;padding:0 0.5em;font-size:14px;white-space:nowrap`,
  ],
  [
    'blockquote:not(.callout)',
    `margin:0.75em 0;padding:0.5em 1em;border-left:3px solid ${BORDER};color:${MUTED}`,
  ],
  // `overflow-x:auto` is not on the allowlist and mail clients cannot scroll a
  // block anyway, so long code lines wrap instead of being clipped.
  [
    'pre',
    `margin:0.75em 0;background-color:${SURFACE};border:1px solid ${BORDER};border-radius:6px;padding:0.9em 1em;font-family:${MONO};font-size:13px;line-height:1.5;white-space:pre-wrap`,
  ],
  // Only inline code gets the chip treatment; a <code> inside a <pre> is left
  // bare and inherits the block's own font and size, which saves restating —
  // and then overriding — the chip declarations on every code block.
  [
    ':not(pre) > code',
    `background-color:${SURFACE};border:1px solid ${BORDER};border-radius:3px;padding:0.1em 0.35em;font-family:${MONO};font-size:13px`,
  ],
  ['table', 'border-collapse:collapse;width:100%;margin:0.75em 0'],
  ['th,td', `border:1px solid ${BORDER};padding:0.4em 0.7em;text-align:left`],
  ['th', `background-color:${SURFACE};font-weight:600`],
  ['img', 'max-width:100%;height:auto'],
  ['hr', `margin:1.5em 0;border:none;border-top:1px solid ${BORDER}`],
];

// Stand-in for a Mermaid diagram, which is an <svg> and cannot survive.
const DIAGRAM_PLACEHOLDER = '[Mermaid diagram — see the attached HTML file]';

function appendStyle(el: Element, declarations: string): void {
  const existing = el.getAttribute('style');
  el.setAttribute('style', existing ? `${existing};${declarations}` : declarations);
}

// The accent family of a callout, read back from the `callout-color-<family>`
// class the Markdown renderer attaches. Unrecognised or absent → gray, matching
// the stylesheet's `--callout-accent` default.
function calloutFamily(el: Element | null): string {
  for (const cls of el?.classList ?? []) {
    if (cls.startsWith('callout-color-')) {
      const family = cls.slice('callout-color-'.length);
      if (family in CALLOUT_ACCENT) return family;
    }
  }
  return 'gray';
}

// Replace `el` with a new element of a different tag, keeping its class and
// children. Used to swap elements MyMail's policy does not allow for ones it
// does; without this the element is unwrapped and its styling lost.
function renameElement(el: Element, tag: string): void {
  const replacement = el.ownerDocument.createElement(tag);
  const cls = el.getAttribute('class');
  if (cls) replacement.setAttribute('class', cls);
  while (el.firstChild) replacement.appendChild(el.firstChild);
  el.replaceWith(replacement);
}

// Resolve a URL against the page's base, keeping only the schemes MyMail's
// policy permits on an href. Returns null for anything else, including a URL
// that fails to parse.
function toAbsolute(raw: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
    ? url.href
    : null;
}

// Rewrite the constructs that cannot travel in an email body into ones that can.
// Each is replaced rather than left to be silently unwrapped by the sanitizer,
// so the recipient sees a legible document instead of stray fragments.
//
// Returns the kinds of content the body could not carry — see LOSSY_KINDS for
// what counts and, just as importantly, what does not.
function rewriteForEmail(root: HTMLElement, lost: Set<string>): void {
  const doc = root.ownerDocument;

  // Mermaid diagrams are SVG. Signpost the attachment rather than dropping them
  // without trace. Runs before the icon sweep below, which would otherwise eat
  // the diagram's <svg> first and leave an empty wrapper — and would then count
  // the same diagram again as an embedded graphic.
  for (const diagram of root.querySelectorAll('.mermaid-diagram')) {
    const para = doc.createElement('p');
    const emphasis = doc.createElement('em');
    emphasis.textContent = DIAGRAM_PLACEHOLDER;
    para.appendChild(emphasis);
    diagram.replaceWith(para);
    lost.add('diagrams');
  }

  // MathML degrades to its own text content in a monospace span — the symbols in
  // reading order. Legible for simple formulas, but the structure (superscripts,
  // fractions, roots) is gone, so this counts as a loss.
  for (const math of root.querySelectorAll('math')) {
    const code = doc.createElement('code');
    code.textContent = math.textContent ?? '';
    math.replaceWith(code);
    lost.add('formulas');
  }

  // Inline <svg> cannot survive, and every one of them counts as a loss. Lucide
  // icons are reported under their own name so the reader is told which of the
  // two went missing.
  //
  // Note that icons reach a note by two routes: written explicitly, and added by
  // the renderer to the title of an alias callout (`[!warning]`, `[!note]`, …).
  // The second is much the commoner, so counting icons means most notes using a
  // callout will travel with the standalone export attached.
  for (const svg of root.querySelectorAll('svg')) {
    lost.add(svg.classList.contains('lucide') ? 'icons' : 'embedded graphics');
    svg.remove();
  }

  // Foldable callouts: <details>/<summary> are not allowed, and unwrapping them
  // would strip the callout styling with the element. Flatten to the same shape
  // a non-foldable callout already has (always expanded — email cannot fold).
  // Nothing is lost but the folding, so this is not counted.
  for (const summary of root.querySelectorAll('summary')) {
    renameElement(summary, 'p');
  }
  for (const details of root.querySelectorAll('details')) {
    renameElement(details, 'blockquote');
  }

  // Task-list checkboxes are <input>. The ballot-box characters carry the same
  // information, so this is a substitution rather than a loss.
  for (const box of root.querySelectorAll('input[type="checkbox"]')) {
    const marker = doc.createElement('span');
    marker.textContent = box.hasAttribute('checked') ? '☑ ' : '☐ ';
    box.replaceWith(marker);
  }
}

// Make every link and image reference absolute. Relative URLs have no meaning
// once the note leaves the app, and MyMail's policy drops an href or src that is
// not absolute anyway — so a link left relative would arrive as bare text.
function absolutizeUrls(root: HTMLElement, base: string, lost: Set<string>): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    const raw = anchor.getAttribute('href') ?? '';
    // A fragment-only link points inside a document the recipient does not have.
    const absolute = raw.startsWith('#') ? null : toAbsolute(raw, base);
    if (absolute) {
      anchor.setAttribute('href', absolute);
    } else {
      anchor.removeAttribute('href'); // keep the link text
    }
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const raw = img.getAttribute('src') ?? '';
    if (raw.startsWith('data:')) continue; // already inlined by the export path
    const absolute = toAbsolute(raw, base);
    if (absolute) {
      img.setAttribute('src', absolute);
    } else {
      lost.add('images');
      img.remove();
    }
  }
}

// Apply the stylesheet as inline attributes: first the element rules, then the
// callout rules, which depend on each callout's accent family and so cannot be
// expressed as a static selector list.
function applyInlineStyles(root: HTMLElement): void {
  for (const [selector, declarations] of STYLE_RULES) {
    for (const el of root.querySelectorAll(selector)) {
      appendStyle(el, declarations);
    }
  }

  for (const callout of root.querySelectorAll('.callout')) {
    const family = calloutFamily(callout);
    const accent = CALLOUT_ACCENT[family];
    // Only the left edge takes the accent; the other three keep the neutral
    // border, standing in for the stylesheet's 35% accent/border mix.
    appendStyle(
      callout,
      `margin:0.75em 0;padding:0.6em 1em;border:1px solid ${BORDER};` +
        `border-left:4px solid ${accent};border-radius:6px;` +
        `background-color:${CALLOUT_TINT[family]};color:${FG}`,
    );
  }
  for (const title of root.querySelectorAll('.callout-title')) {
    appendStyle(title, `margin:0;font-weight:600;color:${CALLOUT_ACCENT[calloutFamily(title.closest('.callout'))]}`);
  }
  for (const para of root.querySelectorAll('.callout-para')) {
    appendStyle(para, `color:${CALLOUT_ACCENT[calloutFamily(para)]}`);
  }
}

// Wrap the styled fragment in the page-level defaults that `body` carries in the
// exported document.
function wrapEmailBody(root: HTMLElement): string {
  return (
    '<div style="max-width:65ch;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    `font-size:16px;line-height:1.7;color:${FG}">` +
    root.innerHTML +
    '</div>'
  );
}

export interface EmailBody {
  html: string;
  // Kinds of content the body could not carry, e.g. ['diagrams', 'formulas'].
  // Empty when the email is a faithful rendering of the note, which is what the
  // caller uses to decide whether attaching the standalone export is worth it.
  //
  // Only genuine content counts. Styling that email cannot express, an unfolded
  // callout, a checkbox rendered as ☐ — those are all reproductions of the same
  // information and are deliberately not reported, or every note would drag an
  // attachment along.
  degraded: string[];
}

// Convert an export fragment (see util/export.ts) into the HTML body of an
// email. The fragment is mutated in place, so callers pass a clone when they
// still need the original. `base` resolves the fragment's relative URLs — the
// page's own base URL in the app.
export function toEmailBody(fragment: HTMLElement, base: string): EmailBody {
  const lost = new Set<string>();
  rewriteForEmail(fragment, lost);
  absolutizeUrls(fragment, base, lost);
  applyInlineStyles(fragment);
  return { html: wrapEmailBody(fragment), degraded: [...lost].sort() };
}
