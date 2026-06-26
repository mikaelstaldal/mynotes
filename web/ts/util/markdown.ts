import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const DATA_IMAGE_RE = /^data:image\/(gif|png|jpeg|webp);/;

const md = new MarkdownIt({ html: true, linkify: true });
// maxNesting is not in @types/markdown-it Options but IS read at runtime from md.options.
(md.options as Record<string, unknown>).maxNesting = 100;

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
    // Details
    'open',
    // Language
    'dir', 'lang',
  ],
  // Three-scheme allow-list (https?/mailto) plus DOMPurify's relative-URL alternation.
  // Load-bearing for in-app /notes/<slug> links.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORCE_BODY: true,
});

// Open external links in a new tab; keep internal links in the same tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
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
