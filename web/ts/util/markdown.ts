import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { base } from '../basepath.js';

const DATA_IMAGE_RE = /^data:image\/(gif|png|jpeg|webp);/;

const md = new MarkdownIt({ html: true, linkify: true });
// maxNesting is not in @types/markdown-it Options but IS read at runtime from md.options.
(md.options as Record<string, unknown>).maxNesting = 100;

// Internal tag links: [[#slug]] or [[#slug|Display text]] render to a link to
// the tag's note list (/tags/<slug>). The slug charset is the same as the API
// tag-slug pattern (^[a-z0-9]+(?:-[a-z0-9]+)*$); the label may be any run of
// characters except ']' and newline. Anything not matching is left as literal
// text, so the [[ / ]] delimiters never collide with Markdown, raw HTML, SVG or
// MathML (none of which use them). The '#' sigil reserves the plain [[slug]]
// space for a possible future note wikilink.
const TAG_LINK_RE = /^\[\[#([a-z0-9]+(?:-[a-z0-9]+)*)(?:\|([^\]\n]+))?\]\]/;

// Registered before 'link' so it consumes [[#…]] before the standard link rule
// sees the leading '['. Inline rules do not run inside code spans/fences or raw
// HTML blocks, so [[#x]] there stays literal.
md.inline.ruler.before('link', 'tag_link', (state, silent) => {
  const start = state.pos;
  // Fast path: only proceed when the next three chars are exactly "[[#".
  if (
    state.src.charCodeAt(start) !== 0x5b /* [ */ ||
    state.src.charCodeAt(start + 1) !== 0x5b /* [ */ ||
    state.src.charCodeAt(start + 2) !== 0x23 /* # */
  ) {
    return false;
  }
  const match = TAG_LINK_RE.exec(state.src.slice(start));
  if (!match) return false;
  const [full, slug, label] = match;
  if (!silent) {
    const open = state.push('link_open', 'a', 1);
    open.attrs = [['href', `${base}/tags/${slug}`]];
    const text = state.push('text', '', 0);
    text.content = label ?? `#${slug}`;
    state.push('link_close', 'a', -1);
  }
  state.pos += full.length;
  return true;
});

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
