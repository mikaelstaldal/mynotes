// Text, Markdown, and validation helpers for the demo backend — the browser
// counterpart of internal/service and the Markdown-aware parts of
// internal/repository. Behaviour follows the Go originals closely enough that
// the UI cannot tell the difference; where a faithful port would mean
// re-implementing a whole parser, the approximation is called out in the
// comment above the function.
//
// See model.ts for why these are globals rather than module exports.

// ── Slugs ────────────────────────────────────────────────────────────────────

/** Mirrors the OpenAPI slug constraint (and service.slugPattern). */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Combining marks left behind by NFKD decomposition (Unicode category Mn). */
const COMBINING_MARK = /\p{Mn}/u;

/**
 * Derives a slug from a title: lowercase, fold accents (NFKD then drop
 * combining marks), drop remaining non-ASCII, collapse runs of other characters
 * to a single hyphen, trim, and truncate. An empty result falls back to "note".
 * Mirrors service.generateSlug.
 */
function generateSlug(title: string): string {
  const decomposed = title.toLowerCase().normalize('NFKD');
  let out = '';
  let dash = false; // collapse consecutive separators into a single hyphen
  for (const ch of decomposed) {
    const code = ch.codePointAt(0) as number;
    if (COMBINING_MARK.test(ch)) {
      // Combining mark from the decomposition (the accent) — drop it.
    } else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      out += ch;
      dash = false;
    } else if (code > 0x7f) {
      // Remaining non-ASCII letters/symbols are dropped, not separated.
    } else if (!dash && out.length > 0) {
      // Any other ASCII (space, punctuation) becomes a separator.
      out += '-';
      dash = true;
    }
  }
  let slug = out.replace(/-+$/, '');
  if (slug.length > MAX_SLUG_LEN) slug = slug.slice(0, MAX_SLUG_LEN).replace(/-+$/, '');
  return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * Appends "-n" to base, first truncating base so base+suffix fits in
 * MAX_SLUG_LEN and re-trimming any trailing hyphen. Mirrors service.withSuffix.
 */
function slugWithSuffix(base: string, n: number): string {
  const suffix = '-' + n;
  const maxBase = MAX_SLUG_LEN - suffix.length;
  if (base.length > maxBase) base = base.slice(0, maxBase).replace(/-+$/, '');
  return base + suffix;
}

/** Validates an explicit (client-supplied) slug. Mirrors service.validateSlug. */
function validateSlug(slug: string): void {
  if (runeLength(slug) > MAX_SLUG_LEN) throw validationError('slug is too long');
  if (!SLUG_PATTERN.test(slug)) {
    throw validationError('slug must be lowercase alphanumerics separated by single hyphens');
  }
}

// ── Field validation ─────────────────────────────────────────────────────────

/** Unicode Cc control characters — what Go's unicode.IsControl matches. */
const CONTROL_CHAR = /\p{Cc}/u;

/**
 * Validates a pre-trimmed title: non-empty, no control characters (tab, newline
 * and CR included), within MAX_TITLE_LEN. Mirrors service.validateTitle. The
 * UTF-8 check has no counterpart — a JavaScript string is already decoded.
 */
function validateTitle(title: string): void {
  if (title === '') throw validationError('title is required');
  if (CONTROL_CHAR.test(title)) throw validationError('title must not contain control characters');
  if (runeLength(title) > MAX_TITLE_LEN) throw validationError('title is too long');
}

/**
 * Validates verbatim Markdown content. Content is never trimmed or otherwise
 * mutated; this only accepts or rejects. Mirrors service.validateContent.
 */
function validateContent(content: string): void {
  if (runeLength(content) > MAX_CONTENT_LEN) throw validationError('content is too long');
  for (const ch of content) {
    if (ch !== '\t' && ch !== '\n' && ch !== '\r' && CONTROL_CHAR.test(ch)) {
      throw validationError('content must not contain control characters');
    }
  }
  validateMarkdownStructure(content);
}

/**
 * Elements embedded HTML may use, from the bluemonday policy in
 * internal/sanitize (its user-content profile plus the SVG and MathML sets).
 * Everything else — script, style, iframe, object, embed, form, link, meta,
 * base, … — is rejected.
 */
const ALLOWED_HTML_ELEMENTS = new Set([
  // Text and structure
  'a', 'abbr', 'acronym', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big',
  'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd',
  'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins',
  'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul',
  'var', 'wbr',
  // GFM task-list checkbox (the only <input> the policy keeps)
  'input',
  // SVG
  'svg', 'g', 'defs', 'desc', 'title', 'symbol', 'switch', 'circle', 'ellipse',
  'line', 'path', 'polygon', 'polyline', 'rect', 'text', 'tspan', 'textpath', 'tref',
  'image', 'lineargradient', 'radialgradient', 'pattern', 'stop', 'clippath', 'mask',
  'marker', 'view', 'font', 'glyph', 'glyphref', 'hkern', 'vkern', 'altglyph',
  'altglyphdef', 'altglyphitem', 'animatecolor', 'animatemotion', 'animatetransform',
  'mpath', 'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite',
  'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap', 'fedistantlight',
  'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
  'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology', 'feoffset',
  'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
  // MathML
  'math', 'menclose', 'merror', 'mfenced', 'mfrac', 'mglyph', 'mi', 'mlabeledtr',
  'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot', 'mrow', 'ms',
  'mspace', 'msqrt', 'mstyle', 'msub', 'msup', 'msubsup', 'mtable', 'mtd', 'mtext',
  'mtr', 'munder', 'munderover', 'mprescripts',
]);

/**
 * A raw HTML tag. The name must be followed by whitespace, "/" or ">", which is
 * what keeps an autolink (`<https://example.com>`) from being read as a tag.
 * Groups: 1 = "/" for an end tag, 2 = name, 3 = the attribute text.
 */
const HTML_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?\/?>/g;

/** An attribute with a quoted, single-quoted, or bare value. */
const HTML_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** A Markdown link or image destination: `[text](dest "title")`. */
const MD_DESTINATION_RE = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]*)>?(?:\s+["'(][^)]*)?\)/g;

/** An autolink: `<scheme:…>`. */
const MD_AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.\-]*:[^\s<>]*)>/g;

/** The canonical data: image allow-list, shared with sanitize.DataImageRaster. */
const DATA_IMAGE_RASTER = /^data:image\/(gif|png|jpeg|webp);/i;

/** A leading RFC 3986 scheme. */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;

/**
 * Validates a link/image destination against the scheme allow-list, which
 * differs by destination kind: images take https and the canonical data: raster
 * set, links take http, https and mailto. No-scheme (relative) destinations are
 * allowed; scheme-relative ("//host/…") ones are not. Mirrors
 * service.checkScheme.
 */
function checkScheme(dest: string, isImage: boolean): void {
  const d = dest.trim();
  // A scheme-relative URL inherits the page scheme to reach an arbitrary host,
  // outside the explicit allow-list — reject it on both links and images.
  if (!d.startsWith('//')) {
    const m = SCHEME_RE.exec(d);
    if (m === null) return; // no scheme: relative destinations are allowed
    const scheme = m[1].toLowerCase();
    if (isImage) {
      // Images: https and the canonical data: raster set only — no http, whose
      // CSP-blocked load would render as a silently broken image.
      if (scheme === 'https' || (scheme === 'data' && DATA_IMAGE_RASTER.test(d))) return;
    } else if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
      return;
    }
  }
  throw validationError(isImage
    ? 'content contains an image with a disallowed URL scheme'
    : 'content contains a link with a disallowed URL scheme');
}

/**
 * The write-time structural gate over note content: rejects embedded HTML
 * outside the allow-list, event-handler attributes, and link/image destinations
 * with a disallowed scheme. Content is never mutated.
 *
 * The server (service.validateMarkdownStructure) reaches the same verdicts by
 * parsing the Markdown with Goldmark and diffing each raw-HTML fragment against
 * a bluemonday re-serialization. Shipping a Markdown parser and an HTML
 * sanitizer into the worker for a demo would be out of proportion, so this
 * scans the source with code spans and fenced blocks removed instead. It can
 * therefore differ from the server at the margins — an attribute the policy
 * would strip is not caught here, and a construct the parser would treat as
 * literal text may be. Neither is load-bearing for safety: the authoritative
 * XSS gate is DOMPurify at render time, on the page, exactly as in the real
 * app, and demo content never leaves the browser it was typed into.
 */
function validateMarkdownStructure(content: string): void {
  const src = stripCode(content);

  HTML_TAG_RE.lastIndex = 0;
  for (let m = HTML_TAG_RE.exec(src); m !== null; m = HTML_TAG_RE.exec(src)) {
    const name = m[2].toLowerCase();
    if (!ALLOWED_HTML_ELEMENTS.has(name)) {
      throw validationError('content contains disallowed HTML');
    }
    const attrText = m[3] ?? '';
    HTML_ATTR_RE.lastIndex = 0;
    for (let a = HTML_ATTR_RE.exec(attrText); a !== null; a = HTML_ATTR_RE.exec(attrText)) {
      const key = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      if (key.startsWith('on')) throw validationError('content contains disallowed HTML');
      if ((name === 'a' && key === 'href') || (name === 'img' && key === 'src')) {
        checkScheme(value, name === 'img');
      }
      if ((name === 'image' || name === 'use') && key === 'href') checkScheme(value, true);
    }
  }

  MD_DESTINATION_RE.lastIndex = 0;
  for (let m = MD_DESTINATION_RE.exec(src); m !== null; m = MD_DESTINATION_RE.exec(src)) {
    checkScheme(m[2], m[1] === '!');
  }

  MD_AUTOLINK_RE.lastIndex = 0;
  for (let m = MD_AUTOLINK_RE.exec(src); m !== null; m = MD_AUTOLINK_RE.exec(src)) {
    // An email autolink is implicitly mailto:, an allow-listed link scheme.
    if (!m[1].includes('@')) checkScheme(m[1], false);
  }
}

/**
 * Blanks out fenced code blocks and inline code spans, keeping line structure
 * and offsets intact so callers can still scan by line. Markdown inside code is
 * literal text, so neither the HTML gate nor the wikilink index may see it.
 */
function stripCode(content: string): string {
  const lines = content.split('\n');
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const run = leadingRun(line);
    if (fenceLen === 0) {
      if ((run.char === '`' || run.char === '~') && run.len >= 3) {
        fenceChar = run.char;
        fenceLen = run.len;
        continue;
      }
      // Inline code spans, replaced by spaces of the same length.
      lines[i] = line.replace(/`+[^`]*`+/g, (s) => ' '.repeat(s.length));
    } else {
      if (run.char === fenceChar && run.len >= fenceLen && line.slice(run.len).trim() === '') {
        fenceLen = 0;
        fenceChar = '';
      }
      lines[i] = ' '.repeat(line.length);
    }
  }
  return lines.join('\n');
}

/** The character a line starts with and how many times it repeats. */
function leadingRun(line: string): { char: string; len: number } {
  if (line === '') return { char: '', len: 0 };
  const char = line[0];
  let len = 0;
  while (len < line.length && line[len] === char) len++;
  return { char, len };
}

// ── Headings ─────────────────────────────────────────────────────────────────

/** An ATX heading line, capturing the heading text. Mirrors service.atxHeadingRe. */
const ATX_HEADING_RE = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/;

/** One heading found by scanHeadings. */
interface Heading {
  line: number;
  level: number;
  text: string;
}

/**
 * Collects the ATX headings outside fenced code blocks, with the same fence
 * tracking the Go side uses.
 */
function scanHeadings(content: string): Heading[] {
  const lines = content.split('\n');
  const headings: Heading[] = [];
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const run = leadingRun(line);
    if (fenceLen === 0) {
      if ((run.char === '`' || run.char === '~') && run.len >= 3) {
        fenceChar = run.char;
        fenceLen = run.len;
        continue;
      }
      const m = ATX_HEADING_RE.exec(line);
      if (m !== null) {
        headings.push({ line: i, level: leadingRun(line).len, text: m[1].trim() });
      }
    } else if (run.char === fenceChar && run.len >= fenceLen && line.slice(run.len).trim() === '') {
      fenceLen = 0;
      fenceChar = '';
    }
  }
  return headings;
}

/** The first ATX heading's text, or "". Mirrors service.firstATXHeading. */
function firstATXHeading(content: string): string {
  const headings = scanHeadings(content);
  return headings.length > 0 ? headings[0].text : '';
}

/** One piece of a note produced by splitByHeadings. */
interface SplitSection {
  title: string;
  body: string;
}

/**
 * Partitions content at the shallowest ATX heading level present. Content
 * before the first heading of that level is dropped; each section runs from its
 * own heading to the next heading of the same level, so deeper subheadings stay
 * nested. Mirrors service.splitByHeadings.
 */
function splitByHeadings(content: string): SplitSection[] {
  const lines = content.split('\n');
  const headings = scanHeadings(content);
  if (headings.length === 0) return [];

  let minLevel = headings[0].level;
  for (const h of headings) if (h.level < minLevel) minLevel = h.level;
  const boundaries = headings.filter((h) => h.level === minLevel);

  return boundaries.map((b, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1].line : lines.length;
    return { title: b.text, body: lines.slice(b.line, end).join('\n').replace(/\n+$/, '') };
  });
}

// ── Wikilinks ────────────────────────────────────────────────────────────────

/**
 * Internal wikilinks: [[slug]], [[slug|text]], [[#slug]], [[#slug|text]].
 * Mirrors repository.mdWikiLinkRE and WIKI_LINK_RE in web/ts/util/markdown.ts.
 * Groups: 1 = sigil ("#" for a tag), 2 = slug, 3 = optional display label.
 */
const WIKI_LINK_RE = /\[\[(#?)([a-z0-9]+(?:-[a-z0-9]+)*)(?:\|([^\]\n]+))?\]\]/g;

/**
 * The distinct note-link target slugs in content, in first-seen order. Tag
 * links ([[#slug]]) and self-references are excluded, and wikilinks inside code
 * are ignored — consistent with how the content renders. Mirrors
 * repository.extractNoteLinks.
 */
function extractNoteLinks(content: string, ownSlug: string): string[] {
  const src = stripCode(content);
  const seen = new Set<string>();
  const out: string[] = [];
  WIKI_LINK_RE.lastIndex = 0;
  for (let m = WIKI_LINK_RE.exec(src); m !== null; m = WIKI_LINK_RE.exec(src)) {
    const [, sigil, slug] = m;
    if (sigil !== '' || slug === ownSlug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

// ── Excerpts ─────────────────────────────────────────────────────────────────

const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const MD_CODE_RE = /`+([^`]*)`+/g;
const MD_STRIKE_RE = /~~([^~]*)~~/g;
/**
 * The Pandoc sub/superscript spans (~x~, ^x^), which carry no whitespace.
 * Applied after MD_STRIKE_RE, so a "~~" pair is already consumed as
 * strikethrough. Mirrors repository.mdSubRE / mdSupRE.
 */
const MD_SUB_RE = /~([^~\s]+)~/g;
const MD_SUP_RE = /\^([^^\s]+)\^/g;
const MD_ORDERED_LIST_RE = /^\d+\.\s+/;
const MD_HRULE_RE = /^[-*_]{3,}\s*$/;
const MD_TABLE_CELL_RE = /^:?-+:?$/;
/** A line starting with a raw HTML/SVG/MathML tag. */
const MD_HTML_LINE_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/;

/** Tags that never require a matching closing tag. */
const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * Whether line is a GFM table delimiter row. A pipe is required, so a bare
 * "---" is not treated as a table. Mirrors repository.isTableDelimiter.
 */
function isTableDelimiter(line: string): boolean {
  let l = line.trim();
  if (!l.includes('|')) return false;
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').every((cell) => MD_TABLE_CELL_RE.test(cell.trim()));
}

/**
 * The browse-list excerpt: the first non-heading, non-blank line, ignoring raw
 * HTML blocks and GFM tables, with inline Markdown stripped and truncated at
 * ~120 code points. Mirrors repository.plainExcerpt.
 */
function plainExcerpt(probe: string): string {
  const lines = probe.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line === '' || line.startsWith('#') || MD_HRULE_RE.test(line)) continue;

    const html = MD_HTML_LINE_RE.exec(line);
    if (html !== null) {
      const closing = html[1] === '/';
      const tag = html[2].toLowerCase();
      const selfClosing = html[3] === '/';
      if (!closing && !selfClosing && !VOID_HTML_TAGS.has(tag)) {
        const closeTag = '</' + tag;
        if (!line.toLowerCase().includes(closeTag)) {
          for (i++; i < lines.length && !lines[i].toLowerCase().includes(closeTag); i++);
        }
      }
      continue;
    }

    // Skip GFM tables: a header row immediately followed by a delimiter row.
    if (i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      for (i++; i + 1 < lines.length && lines[i + 1].trim() !== '' && lines[i + 1].includes('|'); i++);
      continue;
    }

    while (line.startsWith('>')) line = line.slice(1).trim();
    if (line.length >= 2 && '-*+'.includes(line[0]) && line[1] === ' ') line = line.slice(2).trim();
    line = line.replace(MD_ORDERED_LIST_RE, '');
    line = line.replace(MD_IMAGE_RE, '');
    // Wikilinks become their display text (label, else slug; a tag link without
    // a label keeps its '#') before the standard link rule runs.
    line = line.replace(WIKI_LINK_RE, (_s, sigil: string, slug: string, label: string | undefined) =>
      label !== undefined && label !== '' ? label : sigil + slug);
    line = line.replace(MD_LINK_RE, '$1');
    line = line.replace(MD_CODE_RE, '$1');
    line = line.replace(MD_STRIKE_RE, '$1');
    line = line.replace(MD_SUB_RE, '$1');
    line = line.replace(MD_SUP_RE, '$1');
    line = line.split('***').join('').split('**').join('').split('__').join('').split('*').join('');
    line = line.trim();
    if (line === '') continue;

    const runes = [...line];
    return runes.length > 120 ? runes.slice(0, 120).join('') + '…' : line;
  }
  return '';
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * SQLite's FTS5 marks a snippet's matched terms with these sentinel control
 * characters rather than HTML; NoteRows.tsx turns them into <mark> elements
 * after escaping. Kept identical so the demo's snippets highlight the same way.
 */
const SNIPPET_START = '\u0002';
const SNIPPET_END = '\u0003';

/** How many tokens a snippet spans — the argument the server passes snippet(). */
const SNIPPET_TOKENS = 30;

/** One token of a document, with its position in the source text. */
interface Token {
  text: string;
  start: number;
  end: number;
}

/**
 * Splits text the way FTS5's default unicode61 tokenizer does: runs of letters
 * and digits, lowercased, with diacritics folded away.
 */
function ftsTokens(text: string): Token[] {
  const re = /[\p{L}\p{N}]+/gu;
  const out: Token[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ text: foldToken(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function foldToken(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '');
}

/**
 * The search terms of a user query. Every term must match for a note to be a
 * hit, which is FTS5's default AND semantics; the server reaches the same place
 * by quoting each token so none of them can act as an operator.
 */
function searchTerms(query: string): string[] {
  return ftsTokens(query).map((t) => t.text);
}

/** One note's search result: whether it matched, how strongly, and its snippet. */
interface SearchHit {
  matched: boolean;
  score: number;
  snippet: string;
}

/**
 * Matches a note against the query terms and builds the content snippet.
 *
 * The ordering is an approximation: SQLite ranks by bm25, which weighs term
 * rarity across the corpus, while this counts matches. For a demo-sized note
 * set the two put the same handful of notes on top, and every other aspect of
 * the search — AND semantics, which notes match, the snippet's shape and its
 * highlight sentinels — is faithful.
 */
function searchNote(note: DemoNote, terms: string[]): SearchHit {
  const titleTokens = ftsTokens(note.title);
  const contentTokens = ftsTokens(note.content);
  const wanted = new Set(terms);

  let score = 0;
  for (const t of titleTokens) if (wanted.has(t.text)) score += 2; // title hits rank higher
  for (const t of contentTokens) if (wanted.has(t.text)) score++;

  const present = new Set<string>();
  for (const t of titleTokens) if (wanted.has(t.text)) present.add(t.text);
  for (const t of contentTokens) if (wanted.has(t.text)) present.add(t.text);
  if (present.size < wanted.size) return { matched: false, score: 0, snippet: '' };

  return { matched: true, score, snippet: buildSnippet(note.content, contentTokens, wanted) };
}

/**
 * A window of at most SNIPPET_TOKENS tokens around the first match, with the
 * matched tokens wrapped in the FTS5 sentinel characters and an ellipsis on
 * each truncated side. Returns "" when the content holds no match, which is the
 * signal to fall back to the plain excerpt — the same rule the server applies
 * to a snippet with no start sentinel in it.
 */
function buildSnippet(content: string, tokens: Token[], wanted: Set<string>): string {
  const first = tokens.findIndex((t) => wanted.has(t.text));
  if (first < 0) return '';

  // Centre the window on the match, then pull it back inside the document.
  let from = Math.max(0, first - Math.floor(SNIPPET_TOKENS / 4));
  const to = Math.min(tokens.length, from + SNIPPET_TOKENS);
  from = Math.max(0, to - SNIPPET_TOKENS);

  // Text between tokens is kept verbatim, newlines included, as the server's
  // snippet() does. A window that starts at the first token also keeps whatever
  // precedes it (a heading marker, say).
  let out = '';
  let cursor = from === 0 ? 0 : tokens[from].start;
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    out += content.slice(cursor, t.start);
    const raw = content.slice(t.start, t.end);
    out += wanted.has(t.text) ? SNIPPET_START + raw + SNIPPET_END : raw;
    cursor = t.end;
  }
  if (from > 0) out = '…' + out;
  if (to < tokens.length) out = out + '…';
  return out;
}

// ── Frontmatter ──────────────────────────────────────────────────────────────

/** The structured fields of a frontmatter block; absent fields stay empty. */
interface Frontmatter {
  title: string;
  slug: string;
  /** RFC 3339 UTC, or "" when absent or unparseable. */
  date: string;
  tags: string[];
}

const EMPTY_FRONTMATTER: Frontmatter = { title: '', slug: '', date: '', tags: [] };

/**
 * Detects and strips YAML (---), TOML (+++) or JSON ({ … }) frontmatter,
 * returning the structured fields and the remaining content. Mirrors
 * service.parseFrontmatter; the YAML and TOML readers cover the flat
 * title/slug/date/tags shape this application writes and reads, not the full
 * grammars.
 */
function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  if (content.startsWith('---')) {
    const d = splitDelimited(content.slice(3), '---');
    if (d !== null) return { fm: parseYAMLFrontmatter(d.text), body: d.body };
  } else if (content.startsWith('+++')) {
    const d = splitDelimited(content.slice(3), '+++');
    if (d !== null) return { fm: parseTOMLFrontmatter(d.text), body: d.body };
  } else if (content.startsWith('{')) {
    const j = parseJSONFrontmatter(content);
    if (j !== null) return j;
  }
  return { fm: EMPTY_FRONTMATTER, body: content };
}

/**
 * Splits the text between an already-consumed opening delimiter and its
 * matching closing delimiter. Both must occupy their own line. Mirrors
 * service.parseDelimitedFrontmatter.
 */
function splitDelimited(rest: string, delim: string): { text: string; body: string } | null {
  if (rest.startsWith('\r\n')) rest = rest.slice(2);
  else if (rest.startsWith('\n')) rest = rest.slice(1);
  else return null;

  let idx: number;
  if (rest.startsWith(delim)) {
    idx = 0;
  } else {
    idx = rest.indexOf('\n' + delim);
    if (idx === -1) return null;
    idx++; // advance past the \n so rest[idx:] starts at the delimiter
  }

  const text = rest.slice(0, idx);
  rest = rest.slice(idx + delim.length);
  if (rest === '') return { text, body: '' };
  if (rest.startsWith('\r\n')) return { text, body: rest.slice(2) };
  if (rest.startsWith('\n')) return { text, body: rest.slice(1) };
  return null; // trailing non-newline content after the closing delimiter
}

function parseYAMLFrontmatter(text: string): Frontmatter {
  const fm: Frontmatter = { title: '', slug: '', date: '', tags: [] };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(lines[i]);
    if (m === null) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === 'title') fm.title = unquoteScalar(value);
    else if (key === 'slug') fm.slug = unquoteScalar(value);
    else if (key === 'date') fm.date = normalizeDate(unquoteScalar(value));
    else if (key === 'tags') {
      if (value.startsWith('[')) {
        fm.tags = value.replace(/^\[|\]$/g, '').split(',')
          .map((t) => unquoteScalar(t.trim())).filter((t) => t !== '');
      } else if (value === '') {
        // Block sequence: consume the following "- item" lines.
        for (let j = i + 1; j < lines.length; j++) {
          const item = /^\s*-\s+(.*?)\s*$/.exec(lines[j]);
          if (item === null) break;
          fm.tags.push(unquoteScalar(item[1]));
          i = j;
        }
      }
    }
  }
  return fm;
}

/** Strips YAML/TOML quoting, honouring the backslash escapes of a double-quoted scalar. */
function unquoteScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseTOMLFrontmatter(text: string): Frontmatter {
  const scalar = (key: string): string => {
    const m = new RegExp(`^${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(text);
    return m === null ? '' : unquoteScalar(m[1]);
  };
  const tagsLine = /^tags\s*=\s*\[([^\]]*)\]/m.exec(text);
  return {
    title: scalar('title'),
    slug: scalar('slug'),
    date: normalizeDate(scalar('date')),
    tags: tagsLine === null
      ? []
      : tagsLine[1].split(',').map((t) => unquoteScalar(t.trim())).filter((t) => t !== ''),
  };
}

function parseJSONFrontmatter(content: string): { fm: Frontmatter; body: string } | null {
  // The block is the leading JSON object; find its end by brace depth, skipping
  // braces inside strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(0, end));
  } catch {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  return {
    fm: {
      title: typeof obj.title === 'string' ? obj.title : '',
      slug: typeof obj.slug === 'string' ? obj.slug : '',
      date: typeof obj.date === 'string' ? normalizeDate(obj.date) : '',
      tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : [],
    },
    body: content.slice(end).replace(/^[ \t\r\n]+/, ''),
  };
}

/**
 * Normalizes a frontmatter date to the stored RFC 3339 UTC form, or "" when it
 * is absent or unparseable. A value with no zone is read as UTC, matching the
 * zone-less layouts in service.dateFormats (JavaScript would otherwise read
 * some of them as local time).
 */
function normalizeDate(value: string): string {
  const s = value.trim();
  if (s === '') return '';
  const zoneless = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?$/.exec(s);
  const iso = zoneless !== null
    ? `${zoneless[1]}T${zoneless[2] ?? '00:00:00'}Z`
    : s.replace(' ', 'T');
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * The downloadable form of a note: a YAML frontmatter block over the Markdown,
 * round-trip compatible with the Markdown import. Mirrors
 * service.MarkdownWithFrontmatter.
 */
function markdownWithFrontmatter(note: DemoNote): string {
  let fm = `title: ${yamlScalar(note.title)}\nslug: ${yamlScalar(note.slug)}\n`
    + `date: "${note.createdAt}"\n`; // always quoted: a bare RFC 3339 value is a YAML timestamp
  if (note.tags.length > 0) {
    fm += 'tags:\n' + note.tags.map((t) => `    - ${yamlScalar(t)}\n`).join('');
  }
  fm += 'dialect: mynotes\n';
  return `---\n${fm}---\n${wrapMarkdown(note.content)}`;
}

// ── Download re-wrapping ─────────────────────────────────────────────────────

/** The column downloaded Markdown paragraphs are soft-wrapped at. */
const WRAP_WIDTH = 80;

/**
 * Reflows over-long paragraph lines to WRAP_WIDTH, inserting soft line breaks
 * at word boundaries only. Rendering is unaffected: inside a paragraph a single
 * newline is a soft break that renders as a space, so replacing an interior
 * space run with a newline is a no-op for the reader. Mirrors
 * service.wrapMarkdown.
 *
 * Only top-level paragraphs are touched — headings, code, tables, HTML blocks,
 * blockquotes and list items are copied through verbatim. The server finds them
 * with a Markdown parser; this scans line by line instead, and errs towards
 * leaving a run alone. Being wrong is not damaging either way: a missed
 * paragraph merely keeps its long lines, and canStartLine guarantees that no
 * continuation line this does produce can open a block.
 */
function wrapMarkdown(content: string): string {
  if (content === '') return content;
  const lines = content.split('\n');
  const out: string[] = [];

  let fenceChar = '';
  let fenceLen = 0;
  /** Inside a non-paragraph block, which runs to the next blank line. */
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const run = leadingRun(line);

    if (fenceLen > 0) {
      out.push(line);
      if (run.char === fenceChar && run.len >= fenceLen && line.slice(run.len).trim() === '') {
        fenceLen = 0;
        fenceChar = '';
      }
      continue;
    }
    if ((run.char === '`' || run.char === '~') && run.len >= 3) {
      out.push(line);
      fenceChar = run.char;
      fenceLen = run.len;
      continue;
    }
    if (line.trim() === '') {
      out.push(line);
      inBlock = false;
      continue;
    }
    // An indented code block, or a block that has not reached its blank line.
    if (inBlock || line.startsWith('    ')) {
      out.push(line);
      continue;
    }
    // A GFM table: its header row is followed by the delimiter row.
    if (i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      out.push(line);
      inBlock = true;
      continue;
    }
    if (!canStartLine(firstWord(line))) {
      out.push(line);
      inBlock = true;
      continue;
    }

    // A top-level paragraph: every line up to a blank one or a block start.
    const start = out.length;
    let j = i;
    for (; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === '') break;
      if (j > i && !canStartLine(firstWord(next))) break;
      out.push(next);
    }
    // A setext underline turns the run into a heading, which is not wrapped.
    const underlined = j < lines.length && isSetextUnderline(lines[j]);
    if (!underlined) {
      for (let k = start; k < out.length; k++) out[k] = wrapLine(out[k]);
    }
    i = j - 1;
  }
  return out.join('\n');
}

function firstWord(line: string): string {
  return line.trimStart().split(/[ \t]/, 1)[0];
}

function isSetextUnderline(line: string): boolean {
  const t = line.trim();
  return /^=+$/.test(t) || /^-+$/.test(t);
}

/**
 * Soft-wraps one line to WRAP_WIDTH, breaking only at interior space runs and
 * never before a token that could begin a block. The chosen space run becomes a
 * single newline; every other character — leading indentation, interior
 * spacing, trailing hard-break spaces — is preserved exactly. Mirrors
 * service.wrapLine.
 */
function wrapLine(line: string): string {
  if (runeLength(line) <= WRAP_WIDTH) return line;

  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  const prefix = line.slice(0, i);

  // Split the remainder into (word, following-gap) pairs; the last gap holds
  // any trailing whitespace.
  const tokens: Array<{ word: string; gap: string }> = [];
  while (i < line.length) {
    const wordStart = i;
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++;
    const word = line.slice(wordStart, i);
    const gapStart = i;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    tokens.push({ word, gap: line.slice(gapStart, i) });
  }
  if (tokens.length === 0) return line;

  let out = prefix;
  let col = runeLength(prefix);
  for (let t = 0; t < tokens.length; t++) {
    const wordLen = runeLength(tokens[t].word);
    if (t === 0) {
      out += tokens[t].word;
      col += wordLen;
      continue;
    }
    const gap = tokens[t - 1].gap;
    const gapLen = runeLength(gap);
    if (col + gapLen + wordLen > WRAP_WIDTH && canStartLine(tokens[t].word)) {
      out += '\n' + tokens[t].word;
      col = wordLen;
    } else {
      out += gap + tokens[t].word;
      col += gapLen + wordLen;
    }
  }
  return out + tokens[tokens.length - 1].gap;
}

/**
 * Whether word is safe as the first token of a wrapped continuation line — it
 * must not be able to begin or interrupt a block-level construct. Deliberately
 * conservative: an ambiguous token counts as unsafe, at worst leaving a line
 * slightly over width. Mirrors service.canStartLine.
 */
function canStartLine(word: string): boolean {
  if (word === '') return false;
  const runOf = (ch: string): number => {
    let n = 0;
    while (n < word.length && word[n] === ch) n++;
    return n;
  };
  const allSame = (ch: string): boolean => word.length > 0 && runOf(ch) === word.length;

  switch (word[0]) {
    // Blockquote (the space after > is optional), HTML block, table-ish.
    case '>': case '<': case '|':
      return false;
    // ATX heading: 1–6 '#' followed by a space (the break) or end of line.
    case '#':
      return runOf('#') !== word.length || runOf('#') > 6;
    // Bullet marker ("- "/"* "), thematic break ("---"/"***"), setext underline.
    case '-': case '*':
      return !allSame(word[0]);
    case '+':
      return word !== '+';
    case '_':
      return !allSame('_') || word.length < 3; // thematic break ("___", 3+)
    case '=':
      return !allSame('='); // setext heading underline
    case '~':
      return runOf('~') < 3; // fenced code (~~~); ~~strike~~ stays safe
    case '`':
      return runOf('`') < 3; // fenced code (```); `code` stays safe
    default:
      // An ordered-list marker could interrupt a paragraph.
      return !/^\d+[.)]$/.test(word);
  }
}

/**
 * A value that YAML would misread as something other than a plain string: an
 * indicator character at the start, a ": " or " #" inside, surrounding
 * whitespace, or a number/bool/null/timestamp lookalike.
 */
const YAML_NEEDS_QUOTES = /^$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^\s|\s$|^[-+.\d]|^(true|false|null|yes|no|on|off|~)$/i;

/** A YAML scalar: plain where that is unambiguous, double-quoted otherwise. */
function yamlScalar(value: string): string {
  if (!YAML_NEEDS_QUOTES.test(value)) return value;
  return '"' + value.split('\\').join('\\\\').split('"').join('\\"') + '"';
}
