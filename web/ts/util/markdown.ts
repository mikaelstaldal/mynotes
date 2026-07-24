import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { asciiToMathML } from 'asciimath';
import { LUCIDE_ICON_NODES } from 'lucide-icons';
import { EMOJI_SHORTCODES } from 'emoji-data';
import { base } from '../basepath.js';

const DATA_IMAGE_RE = /^data:image\/(gif|png|jpeg|webp);/;

const md = new MarkdownIt({ html: true, linkify: true });
// maxNesting is not in @types/markdown-it Options but IS read at runtime from md.options.
(md.options as Record<string, unknown>).maxNesting = 100;

// Internal wikilinks render to an in-app link:
//   [[slug]]  / [[slug|Display text]]  → a note (/notes/<slug>)
//   [[#slug]] / [[#slug|Display text]] → a tag's note list (/tags/<slug>)
// The optional '#' sigil selects a tag link; without it the target is a note.
// The slug charset is the same as the API slug pattern
// (^[a-z0-9]+(?:-[a-z0-9]+)*$); the label may be any run of characters except
// ']' and newline. The default text is the slug (tag links prefix it with '#').
// Anything not matching is left as literal text, so the [[ / ]] delimiters never
// collide with Markdown, raw HTML, SVG or MathML (none of which use them).
const WIKI_LINK_RE = /^\[\[(#?)([a-z0-9]+(?:-[a-z0-9]+)*)(?:\|([^\]\n]+))?\]\]/;

// Registered before 'link' so it consumes [[…]] before the standard link rule
// sees the leading '['. Inline rules do not run inside code spans/fences or raw
// HTML blocks, so [[x]] there stays literal.
md.inline.ruler.before('link', 'wiki_link', (state, silent) => {
  const start = state.pos;
  // Fast path: only proceed when the next two chars are exactly "[[".
  if (
    state.src.charCodeAt(start) !== 0x5b /* [ */ ||
    state.src.charCodeAt(start + 1) !== 0x5b /* [ */
  ) {
    return false;
  }
  const match = WIKI_LINK_RE.exec(state.src.slice(start));
  if (!match) return false;
  const [full, sigil, slug, label] = match;
  const isTag = sigil === '#';
  if (!silent) {
    const open = state.push('link_open', 'a', 1);
    open.attrs = [['href', `${base}${isTag ? '/tags/' : '/notes/'}${slug}`]];
    const text = state.push('text', '', 0);
    text.content = label ?? (isTag ? `#${slug}` : slug);
    state.push('link_close', 'a', -1);
  }
  state.pos += full.length;
  return true;
});

// Emoji shortcodes: `:name:` renders as the raw Unicode emoji. `name` is any
// GitHub-compatible shortcode in the vendored EMOJI_SHORTCODES map (the web UI's
// emoji picker inserts this `:name:` form). This is a render-time
// transform — the note stores the literal `:name:` verbatim, so a plain API
// consumer (the Android app) sees ordinary text — mirroring the wiki-link and
// icon transforms. An unknown `:name:` is left as literal text, so ordinary uses
// of colons (`12:30`, `a:b`) are untouched. The output is the bare emoji
// character (no HTML), which passes the DOMPurify gate unchanged.
const EMOJI_SHORTCODE_RE = /^:([a-zA-Z0-9_+-]+):/;

md.inline.ruler.after('escape', 'emoji', (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x3a /* : */) return false;
  const match = EMOJI_SHORTCODE_RE.exec(state.src.slice(start));
  if (!match) return false;
  const char = EMOJI_SHORTCODES[match[1].toLowerCase()];
  if (!char) return false; // unknown shortcode -> literal text
  if (!silent) {
    const token = state.push('emoji', '', 0);
    token.markup = match[1];
    token.content = char;
  }
  state.pos += match[0].length;
  return true;
});

md.renderer.rules.emoji = (tokens, idx) => tokens[idx].content;

// GFM task lists: a list item whose first inline text begins with "[ ] ",
// "[x] ", or "[X] " renders a disabled checkbox in place of that marker, and
// its <li>/<ul>/<ol> gain the GitHub-compatible task-list classes for styling.
// Implemented as a core rule over the token stream (the same approach as
// markdown-it-task-lists) rather than a plugin, so it stays self-contained and
// npm-free. Checkboxes are always disabled: the read view is render-only, so a
// task-list checkbox is a status marker, not an interactive control.
const TASK_MARKER_RE = /^\[[ xX]\] /;

// The @types/markdown-it package does not re-export Token from its entry point,
// so derive the token type from the mapped MarkdownIt class instead of importing
// a subpath the vendored single-file bundle can't resolve at runtime.
type MdToken = ReturnType<MarkdownIt['parse']>[number];

function taskListItemClass(token: MdToken, cls: string): void {
  const idx = token.attrIndex('class');
  if (idx < 0) {
    token.attrPush(['class', cls]);
    return;
  }
  const existing = token.attrs![idx][1];
  // Idempotent: the parent list is tagged once per task item, so skip a class
  // that is already present to avoid "contains-task-list contains-task-list".
  if (existing.split(' ').includes(cls)) return;
  token.attrs![idx][1] = existing ? `${existing} ${cls}` : cls;
}

// The list_open token that owns the list_item_open at `itemOpen` is the nearest
// preceding token one nesting level shallower.
function parentListToken(tokens: MdToken[], itemOpen: number): number {
  const target = tokens[itemOpen].level - 1;
  for (let i = itemOpen - 1; i >= 0; i--) {
    if (tokens[i].level === target) return i;
  }
  return -1;
}

md.core.ruler.after('inline', 'task_lists', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (
      inline.type !== 'inline' ||
      tokens[i - 1].type !== 'paragraph_open' ||
      tokens[i - 2].type !== 'list_item_open' ||
      !TASK_MARKER_RE.test(inline.content)
    ) {
      continue;
    }
    const checked = inline.content.charCodeAt(1) !== 0x20; // '[x]'/'[X]' vs '[ ]'
    const box = new state.Token('html_inline', '', 0);
    box.content =
      `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}>`;
    // Prepend the checkbox and drop the "[ ]"/"[x]" marker (3 chars) from both
    // the flattened content and the leading text token.
    inline.children!.unshift(box);
    inline.content = inline.content.slice(3);
    const firstText = inline.children![1];
    if (firstText?.type === 'text') {
      firstText.content = firstText.content.slice(3);
    }
    taskListItemClass(tokens[i - 2], 'task-list-item');
    const parent = parentListToken(tokens, i - 2);
    if (parent >= 0) taskListItemClass(tokens[parent], 'contains-task-list');
  }
});

// Two composable, render-time building blocks and the callouts built from them.
// Everything here is a web-UI transform only: notes are stored verbatim (the
// literal `[!warning]`, `>-` etc.), so they pass the server's structural
// validator unchanged and a plain API consumer (the Android app) sees ordinary
// Markdown. Rendered with tags the DOMPurify gate already allows
// (blockquote/details/summary/p/span/svg, `open`, `class`), so the sanitiser
// allow-list is unchanged.

// Alias -> Lucide icon + colour family (styled in app.css as
// .callout-color-<family>). Aliases follow the Obsidian callout types; each also
// carries a colour so `[!alias]` at the start of a paragraph can tint it. Used
// by both the inline icon rule and the callouts core rule below. An unknown name
// is simply not an alias (it may still be a direct Lucide icon).
const ICON_ALIASES: Record<string, { icon: string; family: string }> = {
  note: { icon: 'pencil', family: 'blue' },
  info: { icon: 'info', family: 'blue' },
  todo: { icon: 'circle-check', family: 'blue' },
  tip: { icon: 'flame', family: 'green' },
  hint: { icon: 'flame', family: 'green' },
  important: { icon: 'flame', family: 'green' },
  success: { icon: 'check', family: 'green' },
  check: { icon: 'check', family: 'green' },
  done: { icon: 'check', family: 'green' },
  question: { icon: 'circle-question-mark', family: 'cyan' },
  help: { icon: 'circle-question-mark', family: 'cyan' },
  faq: { icon: 'circle-question-mark', family: 'cyan' },
  warning: { icon: 'triangle-alert', family: 'amber' },
  caution: { icon: 'triangle-alert', family: 'amber' },
  attention: { icon: 'triangle-alert', family: 'amber' },
  failure: { icon: 'x', family: 'red' },
  fail: { icon: 'x', family: 'red' },
  missing: { icon: 'x', family: 'red' },
  danger: { icon: 'zap', family: 'red' },
  error: { icon: 'zap', family: 'red' },
  bug: { icon: 'bug', family: 'red' },
  abstract: { icon: 'clipboard-list', family: 'gray' },
  summary: { icon: 'clipboard-list', family: 'gray' },
  tldr: { icon: 'clipboard-list', family: 'gray' },
  example: { icon: 'list', family: 'gray' },
  quote: { icon: 'quote', family: 'gray' },
  cite: { icon: 'quote', family: 'gray' },
};

// Building block 1 — inline Lucide icon: `[!name]` anywhere renders a Lucide
// icon inline. `name` is any vendored Lucide icon, or one of the ICON_ALIASES
// (which resolve to their icon and tag the token with a colour family the
// callouts rule reads back). The explicit `[!lucide-<name>]` form always renders
// the literal Lucide icon <name> with no alias lookup and no colour/callout
// semantics — use it to reach an icon whose name is also an alias (e.g.
// `[!lucide-summary]` is the Lucide "summary" icon, not the `summary` callout
// alias). Unknown names are left as literal text. Registered before 'link' so
// `[!x]` is consumed before the standard link rule sees the leading '['.
// renderIconSvg (a hoisted function declaration below) escapes attributes via the
// DOM and the result is re-sanitised by DOMPurify anyway.
const ICON_RE = /^\[!([a-zA-Z][\w-]*)\]/;
const LUCIDE_PREFIX = 'lucide-';

md.inline.ruler.before('link', 'icon', (state, silent) => {
  const start = state.pos;
  if (
    state.src.charCodeAt(start) !== 0x5b /* [ */ ||
    state.src.charCodeAt(start + 1) !== 0x21 /* ! */
  ) {
    return false;
  }
  const match = ICON_RE.exec(state.src.slice(start));
  if (!match) return false;
  const name = match[1].toLowerCase();
  const explicit = name.startsWith(LUCIDE_PREFIX);
  const alias = explicit ? undefined : ICON_ALIASES[name];
  const iconName = explicit ? name.slice(LUCIDE_PREFIX.length) : alias ? alias.icon : name;
  const svg = renderIconSvg(iconName);
  if (!svg) return false; // unknown icon and unknown alias -> literal text
  if (!silent) {
    const token = state.push('html_inline', '', 0);
    token.content = svg;
    // Tag alias icons so the callouts core rule can recover the colour family.
    // Explicit `[!lucide-…]` icons carry no meta, so they never turn into a box
    // or tint a paragraph.
    if (alias) token.meta = { family: alias.family, alias: name };
  }
  state.pos += match[0].length;
  return true;
});

// Building block 2 — box / foldable blockquote: a single marker char right after
// the first '>' of a blockquote turns it into a callout-style box:
//   >-  foldable box, collapsed        >+  foldable box, expanded
//   >*  static (non-foldable) box
// This preprocessing core rule runs before block parsing: it records the marker
// per source line and strips it, so the standard blockquote rule parses clean
// content (`>- x` -> `> x`) and an alias icon stays at the paragraph start. The
// callouts rule below reads the markers back, matched by the blockquote_open
// token's source line. The marker must sit immediately after '>' (so
// `> *italic*` is unaffected); leading `>` markers are allowed so nested
// blockquotes (`> >- inner`) work. Fenced code blocks are tracked so a `>-`
// line inside a ``` fence is left untouched (top-level fences only — a fence
// nested in a blockquote isn't tracked, an accepted edge case).
const BQ_MARKER_RE = /^( {0,3}(?:> ?)*>)([-+*])/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

md.core.ruler.before('block', 'blockquote_box', (state) => {
  if (state.src.indexOf('>') < 0) return;
  const lines = state.src.split('\n');
  const markers: Record<number, string> = {};
  let fence = '';
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const c = FENCE_RE.exec(line);
      if (
        c && c[1][0] === fence[0] && c[1].length >= fence.length &&
        line.slice(c[1].length).trim() === ''
      ) {
        fence = '';
      }
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) {
      fence = f[1];
      continue;
    }
    const m = BQ_MARKER_RE.exec(line);
    if (!m) continue;
    markers[i] = m[2];
    lines[i] = m[1] + line.slice(m[0].length);
    found = true;
  }
  if (found) {
    state.src = lines.join('\n');
    state.env.bqMarker = markers;
  }
});

// The blockquote_close balancing the blockquote_open at `openIdx` (matching by
// token type, which stays 'blockquote_*' even after we retag it to <details>).
function matchingBlockquoteClose(tokens: MdToken[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].type === 'blockquote_open') depth++;
    else if (tokens[i].type === 'blockquote_close') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Append a class to a block token (paragraph/blockquote), preserving any existing.
function appendClass(token: MdToken, cls: string): void {
  const idx = token.attrIndex('class');
  if (idx < 0) token.attrPush(['class', cls]);
  else token.attrs![idx][1] = `${token.attrs![idx][1]} ${cls}`;
}

// The alias family/name if `child` is an alias icon token (see the icon rule).
function aliasIcon(child: MdToken | undefined): { family: string; alias: string } | null {
  if (child && child.type === 'html_inline' && child.meta && child.meta.alias) {
    return child.meta as { family: string; alias: string };
  }
  return null;
}

// Callouts (built from the two blocks) + alias-tinted paragraphs. A blockquote is
// a callout when its first line starts with an alias icon; the `>-`/`>+`/`>*`
// marker (or an Obsidian-style `[!alias]-`/`+`) makes it a box, foldable when
// `-`/`+`. Any paragraph whose first line starts with an alias icon is tinted
// with that alias's colour family.
md.core.ruler.after('inline', 'callouts', (state) => {
  const tokens = state.tokens;
  const markers = (state.env.bqMarker ?? {}) as Record<number, string>;

  // Pass A: box / foldable blockquotes and callouts.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'blockquote_open') continue;
    const pOpen = tokens[i + 1];
    const inline = tokens[i + 2];
    const pClose = tokens[i + 3];
    if (
      !pOpen || pOpen.type !== 'paragraph_open' ||
      !inline || inline.type !== 'inline' ||
      !pClose || pClose.type !== 'paragraph_close'
    ) {
      continue;
    }
    const children = inline.children ?? [];
    const meta = aliasIcon(children[0]);

    let marker = tokens[i].map ? markers[tokens[i].map![0]] : undefined;
    // Obsidian-compat fold: `[!alias]-` / `[!alias]+` — a fold marker directly
    // after the alias icon (no leading space) when no `>-`/`>+` marker was given.
    if (meta && !marker) {
      const t = children[1];
      if (t && t.type === 'text' && (t.content[0] === '-' || t.content[0] === '+')) {
        marker = t.content[0];
        t.content = t.content.slice(1);
      }
    }

    const foldable = marker === '-' || marker === '+';
    const boxed = !!marker || !!meta;
    if (!boxed) continue;

    let cls = 'callout';
    if (meta) cls += ` callout-${meta.alias} callout-color-${meta.family}`;
    if (foldable) cls += ' callout-foldable';
    tokens[i].attrSet('class', cls);

    if (foldable) {
      tokens[i].tag = 'details';
      if (marker === '+') tokens[i].attrSet('open', '');
      const closeIdx = matchingBlockquoteClose(tokens, i);
      if (closeIdx >= 0) tokens[closeIdx].tag = 'details';
    }

    // Every box (foldable, static, or callout) uses its first line as the title.
    // Title children = inline children up to the first line break; body children
    // = everything after it (title and body share one inline token, split at a
    // softbreak).
    let sb = children.findIndex((c) => c.type === 'softbreak' || c.type === 'hardbreak');
    if (sb < 0) sb = children.length;
    let titleChildren = children.slice(0, sb);
    const bodyChildren = children.slice(sb + 1);

    if (meta) {
      // Strip the space left after the alias icon; fall back to the capitalized
      // alias name when the title is otherwise empty. Keeps inline title markup.
      const t = titleChildren[1];
      if (t && t.type === 'text') t.content = t.content.replace(/^[ \t]+/, '');
      const hasText = titleChildren
        .slice(1)
        .some((c) => c.type !== 'text' || c.content.trim() !== '');
      if (!hasText) {
        const label = new state.Token('text', '', 0);
        label.content = meta.alias.charAt(0).toUpperCase() + meta.alias.slice(1);
        titleChildren = [titleChildren[0], label];
      }
    }

    // Build the title row (<summary> when foldable, else <p>) and the body.
    const titleTag = foldable ? 'summary' : 'p';
    const titleOpen = new state.Token('callout_title_open', titleTag, 1);
    titleOpen.block = true;
    titleOpen.attrSet('class', 'callout-title');
    const titleInline = new state.Token('inline', '', 0);
    titleInline.children = titleChildren;
    titleInline.content = '';
    const titleClose = new state.Token('callout_title_close', titleTag, -1);
    titleClose.block = true;

    const segment: MdToken[] = [titleOpen, titleInline, titleClose];
    if (bodyChildren.length > 0) {
      const bodyOpen = new state.Token('paragraph_open', 'p', 1);
      bodyOpen.block = true;
      const bodyInline = new state.Token('inline', '', 0);
      bodyInline.children = bodyChildren;
      bodyInline.content = '';
      const bodyClose = new state.Token('paragraph_close', 'p', -1);
      bodyClose.block = true;
      segment.push(bodyOpen, bodyInline, bodyClose);
    }
    // Replace the first paragraph (open/inline/close) with the title + body.
    tokens.splice(i + 1, 3, ...segment);
  }

  // Pass B: tint any remaining paragraph that starts with an alias icon. Callout
  // title rows use the custom callout_title_* token type, so they're skipped.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'paragraph_open') continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'inline') continue;
    const meta = aliasIcon(inline.children?.[0]);
    if (meta) appendClass(tokens[i], `callout-para callout-color-${meta.family}`);
  }
});

// AsciiMath math: $inline$ and $$display$$
// AsciiMath (https://asciimath.org) written between single dollars renders as
// inline MathML; between double dollars as display (block) MathML. Conversion is
// done at render time by the vendored asciimath2ml library, and the resulting
// <math> element flows through the same DOMPurify gate as all other output (the
// MathML tag/attribute allow-list already covers it), so math markup is
// sanitised like everything else — nothing bypasses the render-time gate. The
// library never throws (malformed input becomes a <merror> node and '<','>','&'
// are entity-escaped), but renderMathML still guards defensively and falls back
// to the literal source so a note never fails to render.
function renderMathML(src: string, display: boolean): string {
  const source = src.trim();
  try {
    const mathml = asciiToMathML(source, !display);
    if (mathml) return mathml;
  } catch {
    // fall through to the literal source below
  }
  return md.utils.escapeHtml(display ? `$$${src}$$` : `$${src}$`);
}

// A '$' at `pos` counts as escaped when preceded by an odd number of backslashes.
function isBackslashEscaped(src: string, pos: number): boolean {
  let count = 0;
  for (let i = pos - 1; i >= 0 && src.charCodeAt(i) === 0x5c /* \ */; i--) count++;
  return count % 2 === 1;
}

// Whether a single '$' at `pos` may open/close inline math. Mirrors
// markdown-it-katex: an opening '$' must not be immediately followed by
// whitespace, and a closing '$' must not be immediately preceded by whitespace
// nor immediately followed by a digit — so currency like "$5 and $10" stays
// literal text rather than being parsed as an (empty) math span.
function inlineDelim(src: string, pos: number, posMax: number): { canOpen: boolean; canClose: boolean } {
  const prev = pos > 0 ? src.charCodeAt(pos - 1) : -1;
  const next = pos + 1 <= posMax ? src.charCodeAt(pos + 1) : -1;
  const prevIsSpace = prev === 0x20 || prev === 0x09;
  const nextIsSpace = next === 0x20 || next === 0x09;
  const nextIsDigit = next >= 0x30 && next <= 0x39;
  return { canOpen: !nextIsSpace, canClose: !prevIsSpace && !nextIsDigit };
}

// Inline display math: $$…$$ on a single inline run (e.g. "see $$x^2$$ here").
// Registered before math_inline so a "$$" is consumed as a display delimiter
// rather than as two empty inline spans. Multi-line $$…$$ is handled by the
// block rule below; this only covers a pair kept within one inline run.
md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false;
  const open = inlineDelim(state.src, start, state.posMax);
  if (!open.canOpen) {
    if (!silent) state.pending += '$';
    state.pos += 1;
    return true;
  }
  let pos = start + 1;
  let close = -1;
  while (pos <= state.posMax) {
    if (
      state.src.charCodeAt(pos) === 0x24 &&
      !isBackslashEscaped(state.src, pos) &&
      inlineDelim(state.src, pos, state.posMax).canClose
    ) {
      close = pos;
      break;
    }
    pos++;
  }
  if (close < 0) return false;
  const content = state.src.slice(start + 1, close);
  if (!content.trim()) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.markup = '$';
    token.content = content;
  }
  state.pos = close + 1;
  return true;
});

md.inline.ruler.before('math_inline', 'math_display', (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x24 || state.src.charCodeAt(start + 1) !== 0x24) {
    return false;
  }
  let pos = start + 2;
  let close = -1;
  while (pos < state.posMax) {
    if (
      state.src.charCodeAt(pos) === 0x24 &&
      state.src.charCodeAt(pos + 1) === 0x24 &&
      !isBackslashEscaped(state.src, pos)
    ) {
      close = pos;
      break;
    }
    pos++;
  }
  if (close < 0) return false;
  const content = state.src.slice(start + 2, close);
  if (!content.trim()) return false;
  if (!silent) {
    const token = state.push('math_display', 'math', 0);
    token.markup = '$$';
    token.content = content;
  }
  state.pos = close + 2;
  return true;
});

// Block display math: a paragraph opened by "$$", spanning one or more lines
// until a line ending in "$$". Adapted from markdown-it-katex's block rule.
md.block.ruler.after('blockquote', 'math_block', (state, startLine, endLine, silent) => {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (pos + 2 > max) return false;
  if (state.src.charCodeAt(pos) !== 0x24 || state.src.charCodeAt(pos + 1) !== 0x24) {
    return false;
  }
  if (silent) return true;
  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let lastLine = '';
  let found = false;
  if (firstLine.trim().endsWith('$$')) {
    firstLine = firstLine.trim().replace(/\$\$$/, '');
    found = true;
  }
  let next = startLine;
  while (!found) {
    next++;
    if (next >= endLine) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    if (pos < max && state.tShift[next] < state.blkIndent) break; // dedent ends the block
    if (state.src.slice(pos, max).trim().endsWith('$$')) {
      const lastPos = state.src.slice(0, max).lastIndexOf('$$');
      lastLine = state.src.slice(pos, lastPos);
      found = true;
    }
  }
  state.line = next + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content =
    (firstLine && firstLine.trim() ? firstLine + '\n' : '') +
    state.getLines(startLine + 1, next, state.tShift[startLine], true) +
    (lastLine && lastLine.trim() ? lastLine : '');
  token.map = [startLine, state.line];
  token.markup = '$$';
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

md.renderer.rules.math_inline = (tokens, idx) => renderMathML(tokens[idx].content, false);
md.renderer.rules.math_display = (tokens, idx) => renderMathML(tokens[idx].content, true);
md.renderer.rules.math_block = (tokens, idx) => renderMathML(tokens[idx].content, true) + '\n';

// Built-in Lucide icons are stored as compact Markdown image references
// (![name](<base>/api/v1/icons/lucide/<name>)), but rendering them as <img> loads
// the SVG in its own document context, where it can't inherit the note's text
// colour (the served icon bakes in a grey stroke). Instead, render a known icon
// inline as an <svg> whose stroke is `currentColor`, so it matches the
// surrounding foreground exactly and follows the light/dark theme — mirroring
// components/Icon.tsx and the server-side HTML export. The regexp anchors on the
// path suffix so it matches root-relative, basepath-prefixed, and absolute srcs
// (any query/fragment is trimmed first), mirroring the server's iconSrcPattern.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_SRC_RE = /(?:^|\/)api\/v1\/icons\/lucide\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

function iconNameFromSrc(src: string): string | null {
  const path = src.replace(/[?#].*$/s, '');
  const m = ICON_SRC_RE.exec(path);
  return m ? m[1] : null;
}

// Builds the inline <svg> markup for a Lucide icon from the vendored geometry.
// Returns null for an unknown name, so the caller can fall back to the default
// <img> rendering. Built via the DOM so attribute values are escaped correctly;
// the geometry is trusted vendored data and the result is re-sanitised by the
// DOMPurify gate in renderNote regardless.
function renderIconSvg(name: string): string | null {
  const nodes = LUCIDE_ICON_NODES[name];
  if (!nodes) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  const svgAttrs: Record<string, string> = {
    xmlns: SVG_NS,
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: `lucide lucide-${name}`,
    'aria-hidden': 'true',
  };
  for (const key of Object.keys(svgAttrs)) svg.setAttribute(key, svgAttrs[key]);
  for (const [tag, attrs] of nodes) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const key of Object.keys(attrs)) child.setAttribute(key, attrs[key]);
    svg.appendChild(child);
  }
  return svg.outerHTML;
}

// Render a built-in icon image reference as inline <svg>; delegate every other
// image to the default renderer so ordinary images and unknown icon names stay
// <img> elements.
const defaultImageRule = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const name = iconNameFromSrc(tokens[idx].attrGet('src') ?? '');
  if (name) {
    const svg = renderIconSvg(name);
    if (svg) return svg;
  }
  return defaultImageRule(tokens, idx, options, env, self);
};

// Broad safe-HTML allow-list matching the server bluemonday UGCPolicy profile.
// Excludes script/style/iframe/object/embed/form-controls/raw-media and all on* handlers.
DOMPurify.setConfig({
  ALLOWED_TAGS: [
    // Prose
    'a', 'abbr', 'acronym', 'b', 'blockquote', 'br', 'cite', 'code',
    'dd', 'del', 'dfn', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q',
    's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup',
    'tt', 'u', 'ul', 'var',
    // Table
    'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
    // Disclosure / sectioning
    'details', 'summary', 'section', 'nav',
    // Figure
    'figure', 'figcaption',
    // Media
    'img',
    // GFM task-list checkbox (constrained to a disabled checkbox by the hook below)
    'input',
  ],
  ALLOWED_ATTR: [
    // Link / image
    'href', 'hreflang', 'title', 'alt', 'src', 'height', 'width',
    // Quotation / annotation
    'cite', 'datetime',
    // Table
    'abbr', 'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
    'colspan', 'headers', 'rowspan', 'scope', 'span', 'valign',
    // List
    'reversed', 'start', 'type',
    // Task-list checkbox (input@type is covered by 'type' above)
    'checked', 'disabled',
    // Details
    'open',
    // Language
    'dir', 'lang',
  ],
  // Three-scheme allow-list (https?/mailto) plus DOMPurify's relative-URL alternation.
  // Load-bearing for in-app /notes/<slug> links.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORCE_BODY: true,
  // ADD_TAGS and ADD_ATTR are additive to ALLOWED_TAGS/ALLOWED_ATTR above (unlike
  // USE_PROFILES which would replace them). They mirror the DOMPurify svg$1 +
  // svgFilters + mathMl$1 profile lists, minus <use>/<animate>/<set>/<style>/<metadata>
  // and <foreignObject> which DOMPurify itself disallows or which require CSS sanitization.
  ADD_TAGS: [
    // SVG presentation elements
    'svg', 'altglyph', 'altglyphdef', 'altglyphitem',
    'animatecolor', 'animatemotion', 'animatetransform',
    'circle', 'clippath', 'defs', 'desc', 'ellipse',
    'filter', 'font', 'g', 'glyph', 'glyphref', 'hkern',
    'image', 'line', 'lineargradient', 'marker', 'mask',
    'mpath', 'path', 'pattern', 'polygon', 'polyline',
    'radialgradient', 'rect', 'stop', 'switch', 'symbol',
    'text', 'textpath', 'title', 'tref', 'tspan', 'view', 'vkern',
    // SVG filter primitives
    'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite',
    'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap',
    'fedistantlight', 'fedropshadow', 'feflood',
    'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
    'fegaussianblur', 'feimage', 'femerge', 'femergenode',
    'femorphology', 'feoffset', 'fepointlight',
    'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
    // MathML elements (DOMPurify mathMl$1 profile)
    'math', 'menclose', 'merror', 'mfenced', 'mfrac', 'mglyph',
    'mi', 'mlabeledtr', 'mmultiscripts', 'mn', 'mo', 'mover',
    'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mspace',
    'msqrt', 'mstyle', 'msub', 'msup', 'msubsup', 'mtable',
    'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'mprescripts',
  ],
  // SVG and MathML attributes (DOMPurify svg + mathMl profile attrs).
  // "style" is intentionally excluded (requires CSS sanitization).
  // Many attrs (href, height, width, type, dir, lang, id, title) are already
  // in ALLOWED_ATTR above; listing them here is harmless (additive, no-op).
  ADD_ATTR: [
    // SVG geometry and presentation
    'accent-height', 'accumulate', 'additive', 'alignment-baseline',
    'amplitude', 'ascent', 'attributename', 'attributetype',
    'azimuth', 'basefrequency', 'baseline-shift', 'begin', 'bias', 'by',
    'class', 'clip', 'clippathunits', 'clip-path', 'clip-rule',
    'color', 'color-interpolation', 'color-interpolation-filters',
    'color-profile', 'color-rendering',
    'cx', 'cy', 'd', 'dx', 'dy',
    'diffuseconstant', 'direction', 'display', 'divisor', 'dur',
    'edgemode', 'elevation', 'end', 'exponent',
    'fill', 'fill-opacity', 'fill-rule', 'filter', 'filterunits',
    'flood-color', 'flood-opacity',
    'font-family', 'font-size', 'font-size-adjust', 'font-stretch',
    'font-style', 'font-variant', 'font-weight',
    'fx', 'fy', 'g1', 'g2', 'glyph-name', 'glyphref',
    'gradientunits', 'gradienttransform',
    'image-rendering', 'in', 'in2', 'intercept',
    'k', 'k1', 'k2', 'k3', 'k4', 'kerning',
    'keypoints', 'keysplines', 'keytimes',
    'lengthadjust', 'letter-spacing',
    'kernelmatrix', 'kernelunitlength', 'lighting-color', 'local',
    'marker-end', 'marker-mid', 'marker-start',
    'markerheight', 'markerunits', 'markerwidth',
    'maskcontentunits', 'maskunits', 'mask', 'mask-type',
    'media', 'method', 'mode', 'numoctaves',
    'offset', 'operator', 'opacity', 'order',
    'orient', 'orientation', 'origin', 'overflow',
    'paint-order', 'path', 'pathlength',
    'patterncontentunits', 'patterntransform', 'patternunits',
    'points', 'preservealpha', 'preserveaspectratio', 'primitiveunits',
    'r', 'rx', 'ry', 'radius', 'refx', 'refy',
    'repeatcount', 'repeatdur', 'restart', 'result', 'rotate',
    'scale', 'seed', 'shape-rendering', 'slope',
    'specularconstant', 'specularexponent', 'spreadmethod',
    'startoffset', 'stddeviation', 'stitchtiles',
    'stop-color', 'stop-opacity',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity',
    'stroke', 'stroke-width',
    'surfacescale', 'systemlanguage', 'tablevalues', 'targetx', 'targety',
    'transform', 'transform-origin',
    'text-anchor', 'text-decoration', 'text-rendering', 'textlength',
    'u1', 'u2', 'unicode', 'values',
    'viewbox', 'visibility', 'version',
    'vert-adv-y', 'vert-origin-x', 'vert-origin-y',
    'word-spacing', 'wrap', 'writing-mode',
    'xchannelselector', 'ychannelselector',
    'x', 'x1', 'x2', 'xmlns', 'y', 'y1', 'y2', 'z', 'zoomandpan',
    // MathML-specific attributes (DOMPurify mathMl profile)
    'accent', 'accentunder', 'bevelled', 'close',
    'columnalign', 'columnlines', 'columnspacing', 'columnspan',
    'denomalign', 'displaystyle', 'encoding',
    'fence', 'frame', 'largeop', 'length', 'linethickness',
    'lquote', 'lspace', 'mathbackground', 'mathcolor',
    'mathsize', 'mathvariant', 'maxsize', 'minsize', 'movablelimits',
    'notation', 'numalign', 'rowalign', 'rowlines', 'rowspacing',
    'rspace', 'rquote', 'scriptlevel', 'scriptminsize',
    'scriptsizemultiplier', 'selection', 'separator', 'separators',
    'stretchy', 'subscriptshift', 'supscriptshift', 'symmetric', 'voffset',
  ],
});

// Constrain <input> to the disabled checkboxes emitted for task-list items:
// drop any other input (e.g. a raw <input type="text"> that reached the render
// gate) before its attributes are processed. This runs before
// afterSanitizeAttributes, which then forces the disabled flag on the survivors.
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'input') return;
  const el = node as Element;
  if (el.getAttribute?.('type') !== 'checkbox') {
    el.parentNode?.removeChild(el);
  }
});

// Open external links in a new tab; keep internal links in the same tab.
// Also force task-list checkboxes to stay non-interactive (read-only view).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  } else if (node.tagName === 'INPUT') {
    node.setAttribute('disabled', '');
  }
});

// Allow data: only on img@src with the canonical raster MIME set; strip it everywhere else.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'src' && node.tagName === 'IMG' && DATA_IMAGE_RE.test(data.attrValue)) {
    data.keepAttr = true;
    return;
  }
  if (data.attrValue.startsWith('data:')) {
    data.keepAttr = false;
  }
});

export function renderNote(markdown: string): string {
  return DOMPurify.sanitize(md.render(markdown));
}

// Run an already-rendered HTML fragment back through the same DOMPurify gate.
// Used by the HTML export after it splices inlined artifact markup (base64 data:
// URLs for raster images, raw <svg>/<math> for vector/MathML artifacts) into the
// rendered body, so the injected content passes the identical allow-list as
// everything else — defense-in-depth, mirroring the server export's re-sanitize.
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

// When a wiki link ([[slug]] / [[#slug]]) — or any other inline-parsed content —
// is inserted directly after a raw HTML block, e.g. an embedded multi-line SVG
// or MathML element, it is swallowed by that block and rendered literally,
// because markdown-it does not run inline rules inside raw HTML blocks (see the
// wiki_link rule above). A CommonMark HTML block opened by a tag alone on its
// line runs until the next blank line, so the insertion needs a blank line to
// break out of it. Given the note text preceding the insertion point, return the
// newline prefix ('', '\n', or '\n\n') that separates the insertion from an open
// raw HTML block, choosing the fewest newlines that still leave a blank line
// between them.
//
// Single-line raw HTML (e.g. `<svg …>…</svg>` on one line) is parsed as inline
// HTML inside a paragraph, not a block, and does not swallow following inline
// content, so it needs no separator.
export function rawHtmlBlockSeparator(before: string): string {
  // Only the block containing the insertion point matters: text before the last
  // blank line is already separated from it.
  const blankLine = /\n[ \t]*\n/g;
  let blockStart = 0;
  for (let m = blankLine.exec(before); m; m = blankLine.exec(before)) {
    blockStart = m.index + m[0].length;
  }
  const block = before.slice(blockStart);
  const firstBreak = block.indexOf('\n');
  if (firstBreak === -1) return ''; // a single-line block never swallows inline content
  // Up to three leading spaces still open an HTML block; more is indented code.
  const firstLine = block.slice(0, firstBreak).replace(/^ {0,3}/, '');
  const opensHtmlBlock =
    /^<[a-zA-Z][^\s/>]*(?:\s[^\n]*?)?\/?>[ \t]*$/.test(firstLine) || // a lone open tag
    /^<\/[a-zA-Z][^\n]*>[ \t]*$/.test(firstLine) ||                  // a lone close tag
    /^<(?:!--|!|\?|script|pre|style|textarea)/i.test(firstLine);     // comment / decl / PI / rawtext
  if (!opensHtmlBlock) return '';
  return before.endsWith('\n') ? '\n' : '\n\n';
}

// Sanitize an SVG or MathML string for direct embedding in markdown.
// DOMPurify.sanitize() (string return) is used because setConfig() above sets
// the SET_CONFIG flag, causing DOMPurify to ignore per-call RETURN_DOM_FRAGMENT.
// The sanitized string is then re-parsed via a <template> element so the browser
// normalizes multi-line opening tags onto one line (required for markdown-it to
// recognise the HTML block) and we can extract just the root element.
// Blank lines inside the element are collapsed so markdown-it doesn't break the
// HTML block at a blank line mid-element.
export function sanitizeSVGOrMathML(html: string): string {
  const clean = DOMPurify.sanitize(html); // already sanitized — safe to parse below
  const tpl = document.createElement('template');
  tpl.innerHTML = clean; // safe: content is DOMPurify-sanitized; <template> is inert (no script execution, no resource loads)
  for (const node of Array.from(tpl.content.children)) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'svg' || tag === 'math') {
      return node.outerHTML
        .replace(/ xmlns(?::\w+)?="[^"]*"/g, '') // strip namespace declarations (redundant in HTML5)
        .replace(/^[ \t]+$/gm, '') // blank out whitespace-only lines left by stripped comments
        .replace(/\n{2,}/g, '\n')  // collapse consecutive empty lines
        .trim();
    }
  }
  return '';
}
