import type { NoteSummary } from '../api/client.js';

// Builds the Mermaid flowchart source for the sidebar note-link graph, plus the
// per-node fill colors (by tag) and the tag→color legend.
//
// Only notes that participate in at least one link (any incoming or outgoing
// wikilink) are drawn — isolated notes would just be noise. Each drawn note
// gets a synthetic Mermaid node id (n0, n1, …) rather than reusing its slug:
// slugs contain hyphens, which are awkward as raw flowchart node ids, and the
// synthetic ids give us a stable handle to map a clicked SVG node back to its
// slug (and to move the current-note highlight / apply colors without
// re-rendering). Edges are the outgoing links, deduped, restricted to targets
// that are themselves drawn (the API only resolves outgoing links to existing
// notes, and any such target has an incoming link so it is always in the drawn
// set).

export interface NodeStyle {
  fill: string; // node background
  text: string; // label color, chosen for contrast against `fill`
}

export interface LegendEntry {
  label: string; // tag slug, or the untagged sentinel
  color: string; // swatch color (matches the node fill)
}

export interface GraphResult {
  // Mermaid source, or '' when no note is linked (caller shows an empty state).
  source: string;
  // Synthetic node id (n0, n1, …) -> note slug, for click + highlight wiring.
  idToSlug: Map<string, string>;
  // Synthetic node id -> fill/text colors, applied to the rendered SVG.
  idToStyle: Map<string, NodeStyle>;
  // Synthetic node id -> hover tooltip text listing the note's tags.
  idToTooltip: Map<string, string>;
  // Distinct tags present among drawn notes (sorted), each with its color;
  // an "(untagged)" entry is appended when some drawn note has no tags.
  legend: LegendEntry[];
}

// Fills are deliberately light pastels and the label is always dark, so nodes
// stay readable in both light and dark themes (Mermaid's own per-theme text
// color can't be relied on once we override the fill).
const NODE_TEXT = '#1f2937';
const UNTAGGED_LABEL = '(untagged)';
const UNTAGGED_FILL = '#e5e7eb';

// Deterministic light pastel per tag slug: a stable hue from the slug, fixed
// saturation/lightness. Same tag → same color across renders; distinct enough
// for the handful of tags a personal note set carries.
function tagColor(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 65%, 85%)`;
}

// The tag that colors a note's box. A note can carry several tags; we pick the
// alphabetically-first slug so the choice is stable regardless of the order the
// tags arrive in. The legend shows every tag, so the others aren't lost.
function representativeTag(note: NoteSummary): string | undefined {
  if (note.tags.length === 0) return undefined;
  return note.tags.map((t) => t.slug).sort()[0];
}

// Hover-tooltip text for a note's box: all of its tags (sorted), or a hint when
// it has none.
function tooltipFor(note: NoteSummary): string {
  if (note.tags.length === 0) return 'No tags';
  const tags = note.tags.map((t) => t.slug).sort();
  return `Tags: ${tags.join(', ')}`;
}

// Make a note title safe to drop inside a Mermaid `["…"]` node label. Under
// htmlLabels:false (required, see mermaid.ts) Mermaid renders labels as SVG
// <text> and, crucially, prints HTML/entity escapes *literally* — so `#quot;` or
// `&quot;` would show up verbatim rather than as a quote. The only characters
// that actually misrender are the double quote (closes the label / double-
// escapes) and `<` (its trailing text is dropped as a pseudo-tag); every other
// punctuation mark (`#`, `&`, `[`, `]`, `|`, …) renders fine. So instead of
// entity-escaping we substitute look-alike Unicode punctuation. Titles are
// server-validated to have no control characters, so there are no newlines to
// handle. This is a rendering-fidelity concern, not an XSS one — the SVG still
// passes through the DOMPurify gate in mermaid.ts.
function escapeLabel(title: string): string {
  return title
    .replace(/"/g, '”') // " -> ” (right double quotation mark)
    .replace(/</g, '‹'); // < -> ‹ (single left-pointing angle quote)
}

export function buildGraphSource(notes: NoteSummary[]): GraphResult {
  const idToSlug = new Map<string, string>();
  const slugToId = new Map<string, string>();
  const idToStyle = new Map<string, NodeStyle>();
  const idToTooltip = new Map<string, string>();

  // Assign a synthetic id to every linked note, in list order.
  const linked = notes.filter(
    (n) => n.incoming_links.length > 0 || n.outgoing_links.length > 0,
  );
  linked.forEach((n, i) => {
    const id = `n${i}`;
    idToSlug.set(id, n.slug);
    slugToId.set(n.slug, id);
    const tag = representativeTag(n);
    idToStyle.set(id, { fill: tag ? tagColor(tag) : UNTAGGED_FILL, text: NODE_TEXT });
    idToTooltip.set(id, tooltipFor(n));
  });

  // Legend: every distinct tag among drawn notes (sorted), plus an untagged
  // sentinel when some drawn note carries no tag.
  const tagSet = new Set<string>();
  let hasUntagged = false;
  for (const n of linked) {
    if (n.tags.length === 0) hasUntagged = true;
    for (const t of n.tags) tagSet.add(t.slug);
  }
  const legend: LegendEntry[] = [...tagSet]
    .sort()
    .map((slug) => ({ label: slug, color: tagColor(slug) }));
  if (hasUntagged) legend.push({ label: UNTAGGED_LABEL, color: UNTAGGED_FILL });

  if (linked.length === 0) return { source: '', idToSlug, idToStyle, idToTooltip, legend };

  const lines = ['graph LR'];
  for (const n of linked) {
    lines.push(`  ${slugToId.get(n.slug)}["${escapeLabel(n.title)}"]`);
  }

  // Deduped directed edges (source -> target) from the outgoing links.
  const seen = new Set<string>();
  for (const n of linked) {
    const src = slugToId.get(n.slug)!;
    for (const link of n.outgoing_links) {
      const dst = slugToId.get(link.slug);
      if (!dst) continue; // target not drawn (shouldn't happen for resolved links)
      const key = `${src}->${dst}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${src} --> ${dst}`);
    }
  }

  return { source: lines.join('\n'), idToSlug, idToStyle, idToTooltip, legend };
}
