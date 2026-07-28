// Converts an HTML document to Markdown, for the demo backend's import path.
// A port of internal/htmlmd, walking a DOM parsed by DOMParser instead of a
// golang.org/x/net/html tree; the conversion rules, and so the output, are the
// same.
//
// It lives on the page rather than in the service worker because a service
// worker has no DOMParser — see web/ts/demo-sw.ts, which sends the document
// here over a MessageChannel and stores what comes back.
//
// Conversion rules:
//   - Tags with direct Markdown equivalents become Markdown syntax.
//   - Tags the application's sanitization policy allows but Markdown cannot
//     express are kept as raw HTML.
//   - Tags outside that policy lose their start/end tags but keep their text
//     (except <script>/<style>, which are dropped whole).

/** The result of a conversion. */
export interface HtmlToMarkdown {
  /**
   * The <title> element's text, the first h1–h6's plain text, or '' when the
   * document has neither.
   */
  title: string;
  /** The converted Markdown, trimmed. */
  content: string;
}

/** Guards against stack overflow on pathologically nested HTML. */
const MAX_WALK_DEPTH = 200;

/** Dropped entirely: dangerous, or carrying no note content. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math']);

/** Structural containers with no Markdown equivalent: keep children, add a block gap. */
const TRANSPARENT_BLOCKS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside',
  'center', 'form', 'label', 'address', 'fieldset',
]);

/**
 * Elements the application's bluemonday policy allows but Markdown cannot
 * express: emitted as raw HTML, which the write-time validation then accepts.
 */
const PASSTHROUGH = new Set([
  'abbr', 'acronym', 'bdo', 'big', 'cite', 'dfn', 'details', 'dl', 'dt', 'dd',
  'figcaption', 'figure', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 'samp',
  'small', 'span', 'sub', 'summary', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);

/** Per-element attribute allow-list for the raw-HTML passthrough. */
const SAFE_ATTRS: Record<string, Set<string>> = {
  abbr: new Set(['title']),
  acronym: new Set(['title']),
  dfn: new Set(['title']),
  time: new Set(['datetime']),
  th: new Set(['align', 'colspan', 'rowspan', 'scope']),
  td: new Set(['align', 'colspan', 'rowspan']),
  col: new Set(['span', 'align']),
  colgroup: new Set(['span']),
  q: new Set(['cite']),
};

/** Elements that must not be given a closing tag. */
const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'input', 'col', 'wbr']);

interface ListLevel {
  ordered: boolean;
  counter: number;
}

interface TableAccum {
  headerRows: string[][];
  bodyRows: string[][];
  inHeader: boolean;
  curRow: string[];
  /** Per-column alignment from each <th align>. */
  aligns: string[];
}

/** Parses htmlDoc and converts its <body> to Markdown. */
export function htmlToMarkdown(htmlDoc: string): HtmlToMarkdown {
  const doc = new DOMParser().parseFromString(htmlDoc, 'text/html');
  const converter = new Converter();

  const titleElement = doc.head?.querySelector('title');
  if (titleElement !== null && titleElement !== undefined) {
    converter.title = (titleElement.textContent ?? '').trim();
  }
  converter.walkChildren(doc.body ?? doc.documentElement, 0);

  return { title: converter.title.trim(), content: converter.text().trim() };
}

class Converter {
  /** From <head><title>, else the first heading (see mergeFirstHeading). */
  title = '';
  /** The first h1–h6's plain text, used as the title when there is no <title>. */
  firstHeading = '';

  private buf = '';
  /** Deferred newlines, flushed before the next write. */
  private pendingNLs = 0;
  /** Inside <pre>: text is written raw, with no escaping. */
  private inPre = false;
  private listStack: ListLevel[] = [];
  private tableState: TableAccum | null = null;

  text(): string {
    return this.buf;
  }

  // ── Output helpers ─────────────────────────────────────────────────────────

  private flushPendingNLs(): void {
    if (this.buf.length === 0) {
      this.pendingNLs = 0;
      return;
    }
    this.buf += '\n'.repeat(this.pendingNLs);
    this.pendingNLs = 0;
  }

  private write(s: string): void {
    if (s === '') return;
    this.flushPendingNLs();
    this.buf += s;
  }

  /** Schedules a blank line before the next write. */
  private ensureBlock(): void {
    if (this.pendingNLs < 2) this.pendingNLs = 2;
  }

  /** Schedules a single newline before the next write. */
  private ensureNewline(): void {
    if (this.pendingNLs < 1) this.pendingNLs = 1;
  }

  // ── Walk ───────────────────────────────────────────────────────────────────

  private walk(node: Node, depth: number): void {
    if (depth > MAX_WALK_DEPTH) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const data = node.nodeValue ?? '';
      if (this.inPre) {
        this.write(data);
      } else {
        // Collapse newlines: block structure comes from elements, not source layout.
        this.write(escapeMarkdownText(data.split('\n').join(' ')));
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      this.handleElement(node as Element, depth);
    }
    // Comments, doctypes, and processing instructions are skipped.
  }

  walkChildren(node: Node, depth: number): void {
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      this.walk(child, depth + 1);
    }
  }

  // ── Element dispatch ───────────────────────────────────────────────────────

  private handleElement(el: Element, depth: number): void {
    const tag = el.tagName.toLowerCase();

    if (SKIPPED.has(tag)) return;

    if (TRANSPARENT_BLOCKS.has(tag) || tag === 'p') {
      this.ensureBlock();
      this.walkChildren(el, depth);
      this.ensureBlock();
      return;
    }

    const headingLevel = HEADING_LEVELS.indexOf(tag) + 1;
    if (headingLevel > 0) {
      this.ensureBlock();
      if (this.firstHeading === '') this.firstHeading = (el.textContent ?? '').trim();
      if (this.title === '' && this.firstHeading !== '') this.title = this.firstHeading;
      this.write('#'.repeat(headingLevel) + ' ');
      this.walkChildren(el, depth);
      this.ensureBlock();
      return;
    }

    switch (tag) {
      case 'hr':
        this.ensureBlock();
        this.write('---');
        this.ensureBlock();
        return;

      case 'ul':
      case 'ol': {
        const nested = this.listStack.length > 0;
        if (nested) this.ensureNewline();
        else this.ensureBlock();
        this.listStack.push({ ordered: tag === 'ol', counter: 1 });
        this.walkChildren(el, depth);
        this.listStack.pop();
        if (!nested) this.ensureBlock();
        return;
      }

      case 'li': {
        if (this.listStack.length === 0) {
          this.walkChildren(el, depth);
          return;
        }
        const indent = '  '.repeat(Math.max(0, this.listStack.length - 1));
        this.ensureNewline();
        const level = this.listStack[this.listStack.length - 1];
        const marker = level.ordered ? `${level.counter++}. ` : '- ';
        this.write(indent + marker + taskMarker(el));
        this.walkChildren(el, depth);
        this.pendingNLs = 1;
        return;
      }

      case 'blockquote': {
        this.ensureBlock();
        const sub = this.subConverter();
        sub.walkChildren(el, 0);
        this.mergeFirstHeading(sub);
        for (const line of sub.text().replace(/\n+$/, '').split('\n')) {
          this.write(line.trim() === '' ? '>' : '> ' + line);
          this.buf += '\n';
        }
        this.pendingNLs = 2;
        return;
      }

      case 'pre':
        this.ensureBlock();
        this.write('```' + codeLanguage(el) + '\n');
        this.inPre = true;
        this.walkChildren(el, depth); // a <code> child is transparent in pre mode
        this.inPre = false;
        this.ensureNewline();
        this.write('```');
        this.ensureBlock();
        return;

      case 'code':
        if (this.inPre) {
          this.walkChildren(el, depth);
        } else {
          const raw = el.textContent ?? '';
          this.write(raw.includes('`') ? '`` ' + raw + ' ``' : '`' + raw + '`');
        }
        return;

      case 'strong':
      case 'b':
        this.wrapInline(el, '**');
        return;

      case 'em':
      case 'i':
        this.wrapInline(el, '*');
        return;

      case 'del':
      case 's':
      case 'strike':
        this.wrapInline(el, '~~');
        return;

      case 'a': {
        const href = el.getAttribute('href') ?? '';
        const sub = this.subConverter();
        sub.walkChildren(el, 0);
        this.mergeFirstHeading(sub);
        const inner = sub.text().trim();
        this.write(href !== '' ? `[${inner}](${href})` : inner);
        return;
      }

      case 'img': {
        const src = el.getAttribute('src') ?? '';
        if (src === '') return;
        this.write(`![${escapeMarkdownText(el.getAttribute('alt') ?? '')}](${src})`);
        return;
      }

      case 'br':
        this.write('  \n');
        return;

      case 'table': {
        this.ensureBlock();
        const saved = this.tableState;
        this.tableState = { headerRows: [], bodyRows: [], inHeader: false, curRow: [], aligns: [] };
        this.walkChildren(el, depth);
        this.renderGFMTable();
        this.tableState = saved;
        this.ensureBlock();
        return;
      }

      case 'thead':
        if (this.tableState !== null) this.tableState.inHeader = true;
        this.walkChildren(el, depth);
        if (this.tableState !== null) this.tableState.inHeader = false;
        return;

      case 'tbody':
      case 'tfoot':
      case 'caption':
        this.walkChildren(el, depth);
        return;

      case 'colgroup':
      case 'col':
        return; // structural metadata; no Markdown output

      case 'tr': {
        if (this.tableState === null) {
          this.walkChildren(el, depth);
          return;
        }
        this.tableState.curRow = [];
        this.walkChildren(el, depth);
        const rows = this.tableState.inHeader ? this.tableState.headerRows : this.tableState.bodyRows;
        rows.push(this.tableState.curRow);
        return;
      }

      case 'th':
      case 'td': {
        if (this.tableState === null) {
          this.walkChildren(el, depth);
          return;
        }
        const sub = this.subConverter();
        sub.walkChildren(el, 0);
        this.mergeFirstHeading(sub);
        // Escape pipes so cell content cannot break the GFM table, and collapse
        // newlines — a GFM cell is single-line.
        const cell = sub.text().trim().split('|').join('\\|').split('\n').join(' ');
        this.tableState.curRow.push(cell);
        if (tag === 'th') this.tableState.aligns.push(el.getAttribute('align') ?? '');
        return;
      }
    }

    if (PASSTHROUGH.has(tag)) {
      this.write(serializeElement(el));
      return;
    }

    // Unrecognized element: strip the tag, keep the text content.
    this.walkChildren(el, depth);
  }

  private wrapInline(el: Element, marker: string): void {
    const sub = this.subConverter();
    sub.walkChildren(el, 0);
    this.mergeFirstHeading(sub);
    const inner = sub.text().trim();
    if (inner !== '') this.write(marker + inner + marker);
  }

  // ── Table rendering ────────────────────────────────────────────────────────

  private renderGFMTable(): void {
    const ts = this.tableState;
    if (ts === null) return;
    const allRows = [...ts.headerRows, ...ts.bodyRows];
    if (allRows.length === 0) return;

    let maxCols = 1;
    for (const row of allRows) if (row.length > maxCols) maxCols = row.length;

    const header = padRow(ts.headerRows.length > 0 ? ts.headerRows[0] : allRows[0], maxCols);
    const dataRows = ts.headerRows.length > 0
      ? [...ts.headerRows.slice(1), ...ts.bodyRows]
      : allRows.slice(1);

    const seps: string[] = [];
    for (let i = 0; i < maxCols; i++) {
      switch ((ts.aligns[i] ?? '').toLowerCase()) {
        case 'center': seps.push(':---:'); break;
        case 'right': seps.push('---:'); break;
        case 'left': seps.push(':---'); break;
        default: seps.push('---');
      }
    }

    this.write('| ' + header.join(' | ') + ' |\n');
    this.write('| ' + seps.join(' | ') + ' |\n');
    for (const row of dataRows) this.write('| ' + padRow(row, maxCols).join(' | ') + ' |\n');
  }

  // ── Sub-converter ──────────────────────────────────────────────────────────

  /**
   * A child converter for inline contexts (strong, em, table cells) and
   * blockquote inner content. It inherits inPre and the list stack.
   */
  private subConverter(): Converter {
    const sub = new Converter();
    sub.inPre = this.inPre;
    sub.listStack = this.listStack.slice();
    return sub;
  }

  private mergeFirstHeading(sub: Converter): void {
    if (this.firstHeading === '' && sub.firstHeading !== '') this.firstHeading = sub.firstHeading;
    if (this.title === '' && this.firstHeading !== '') this.title = this.firstHeading;
  }
}

const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

function padRow(row: string[], n: number): string[] {
  const out = row.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

// ── Serialization ────────────────────────────────────────────────────────────

/** Re-serializes an element and its subtree, keeping only allow-listed attributes. */
function serializeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const allowed = SAFE_ATTRS[tag];
  let out = '<' + tag;
  if (allowed !== undefined) {
    for (const attr of el.attributes) {
      const key = attr.name.toLowerCase();
      if (allowed.has(key)) out += ` ${key}="${escapeHTML(attr.value)}"`;
    }
  }
  out += '>';
  if (VOID_ELEMENTS.has(tag)) return out;
  for (let child = el.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) out += escapeHTML(child.nodeValue ?? '');
    else if (child.nodeType === Node.ELEMENT_NODE) out += serializeElement(child as Element);
  }
  return out + '</' + tag + '>';
}

/** Matches Go's html.EscapeString, which escapes all five of these. */
function escapeHTML(s: string): string {
  return s
    .split('&').join('&amp;')
    .split("'").join('&#39;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&#34;');
}

/**
 * Escapes the characters that carry syntactic meaning in Markdown inline
 * context. '>' and '#' are left alone: both only trigger at line start.
 */
function escapeMarkdownText(s: string): string {
  let out = '';
  for (const ch of s) {
    if ('\\*_`[]~^<!|'.includes(ch)) out += '\\';
    out += ch;
  }
  return out;
}

// ── DOM utilities ────────────────────────────────────────────────────────────

/**
 * The GFM task-list marker ("[ ] " / "[x] ") for a list item whose first
 * element child is a checkbox, or '' when it is not a task item. A single run of
 * leading spaces on the text after the checkbox is trimmed so the marker and
 * label end up separated by exactly one space. Only the tight form — the input
 * a direct child of <li>, as markdown-it and GitHub produce — is recognised.
 */
function taskMarker(li: Element): string {
  for (let child = li.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue ?? '').trim() === '') continue; // insignificant whitespace
      return '';
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.tagName.toLowerCase() !== 'input') return '';
    if ((el.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') return '';
    const next = el.nextSibling;
    if (next !== null && next.nodeType === Node.TEXT_NODE) {
      next.nodeValue = (next.nodeValue ?? '').replace(/^ +/, '');
    }
    return el.hasAttribute('checked') ? '[x] ' : '[ ] ';
  }
  return '';
}

/** The language of a `<pre>` from its child `<code class="language-X">`. */
function codeLanguage(pre: Element): string {
  for (let child = pre.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.tagName.toLowerCase() !== 'code') continue;
    for (const cls of (el.getAttribute('class') ?? '').split(/\s+/)) {
      if (cls.startsWith('language-')) return cls.slice('language-'.length);
    }
  }
  return '';
}
