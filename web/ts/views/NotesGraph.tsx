import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api, type NoteSummary } from '../api/client.js';
import { navigate } from '../router.js';
import { showToast } from '../util/toast.js';
import { useSlowLoading } from '../util/loading.js';
import { renderMermaidBlocks } from '../util/mermaid.js';
import { buildGraphSource, type NodeStyle, type LegendEntry } from '../util/graph.js';
import { Icon } from '../components/Icon.js';

const PAGE = 200; // /notes max page size

interface Props {
  listKey?: number;
  // Slug of the note open in the main panel, highlighted in the graph.
  activeSlug?: string;
  // 'sidebar' (default) renders the compact left-panel graph; 'main' renders the
  // large main-panel graph shown while on the /graph route.
  variant?: 'sidebar' | 'main';
}

// Recover the synthetic node id (n0, n1, …) from a rendered Mermaid node group.
// Mermaid names flowchart node groups `flowchart-<nodeId>-<counter>`.
function nodeIdFromElement(g: Element): string | null {
  const id = g.getAttribute('id') ?? '';
  const m = /^flowchart-(n\d+)(?:-|$)/.exec(id);
  return m ? m[1] : null;
}

// Toggle the current-note highlight class on the rendered SVG in place, so
// navigating between notes doesn't require re-rendering the whole graph.
function applyHighlight(container: HTMLElement, idToSlug: Map<string, string>, slug?: string): void {
  container.querySelectorAll('g.node').forEach((g) => {
    const id = nodeIdFromElement(g);
    const isCurrent = id != null && slug != null && idToSlug.get(id) === slug;
    g.classList.toggle('graph-node-current', isCurrent);
  });
}

// Paint each node its tag color. Set inline (post-sanitize, post-render) so it
// wins over Mermaid's id-scoped stylesheet; fill only, so it composes with the
// current-note highlight (which is a stroke). Untagged nodes get a neutral fill.
function applyColors(container: HTMLElement, idToStyle: Map<string, NodeStyle>): void {
  container.querySelectorAll<SVGGElement>('g.node').forEach((g) => {
    const id = nodeIdFromElement(g);
    const style = id ? idToStyle.get(id) : undefined;
    if (!style) return;
    g.querySelectorAll<SVGElement>('rect, polygon, circle, path').forEach((shape) => {
      shape.style.fill = style.fill;
    });
    g.querySelectorAll<SVGElement>('text, tspan').forEach((t) => {
      t.style.fill = style.text;
    });
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Give each node a native hover tooltip listing the note's tags, via an SVG
// <title> child (browsers render it as a tooltip). Runs post-render on our own
// text, so no sanitization is involved.
function applyTooltips(container: HTMLElement, idToTooltip: Map<string, string>): void {
  container.querySelectorAll<SVGGElement>('g.node').forEach((g) => {
    const id = nodeIdFromElement(g);
    const text = id ? idToTooltip.get(id) : undefined;
    if (!text) return;
    let title = g.querySelector<SVGTitleElement>(':scope > title');
    if (!title) {
      title = document.createElementNS(SVG_NS, 'title');
      g.insertBefore(title, g.firstChild);
    }
    title.textContent = text;
  });
}

// Sidebar tab that renders the whole note-link graph as a clickable Mermaid
// diagram. Only notes with at least one link are drawn; clicking a node opens
// that note, and the currently-open note is highlighted.
export function NotesGraph({ listKey, activeSlug, variant = 'sidebar' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const idToSlugRef = useRef<Map<string, string>>(new Map());
  // Latest activeSlug, so the async render can highlight without being a dep.
  const activeSlugRef = useRef(activeSlug);
  activeSlugRef.current = activeSlug;
  const genRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const slowLoading = useSlowLoading(loading);
  const [empty, setEmpty] = useState(false);
  const [legend, setLegend] = useState<LegendEntry[]>([]);
  // The Mermaid source of the currently-rendered graph, shown via the info-icon
  // tooltip in the top-right corner.
  const [source, setSource] = useState('');

  const load = useCallback(async (gen: number) => {
    setLoading(true);
    try {
      // Fetch every note (paged) so the graph is complete.
      const all: NoteSummary[] = [];
      let offset = 0;
      for (;;) {
        const res = await api.notes.list({ limit: PAGE, offset });
        if (genRef.current !== gen) return;
        all.push(...res.notes);
        offset += res.notes.length;
        if (res.notes.length === 0 || offset >= res.total) break;
      }

      const { source, idToSlug, idToStyle, idToTooltip, legend } = buildGraphSource(all);
      idToSlugRef.current = idToSlug;
      setLegend(legend);
      const container = containerRef.current;
      if (!container) return;

      if (!source) {
        container.innerHTML = '';
        setSource('');
        setEmpty(true);
        return;
      }
      setSource(source);
      setEmpty(false);

      // Hand the source to the shared Mermaid renderer as a fenced block, reusing
      // its theming, validation and SVG sanitization. It replaces the <pre> with
      // a rendered <div class="mermaid-diagram">.
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = source;
      pre.appendChild(code);
      container.innerHTML = '';
      container.appendChild(pre);
      await renderMermaidBlocks(container);
      if (genRef.current !== gen) return;
      applyColors(container, idToStyle);
      applyTooltips(container, idToTooltip);
      applyHighlight(container, idToSlug, activeSlugRef.current);
    } catch (e) {
      if (genRef.current !== gen) return;
      showToast(`Failed to load graph: ${(e as Error).message}`);
    } finally {
      if (genRef.current === gen) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const gen = ++genRef.current;
    void load(gen);
  }, [load, listKey]);

  // Move the highlight when the open note changes, without a refetch/re-render.
  useEffect(() => {
    const container = containerRef.current;
    if (container) applyHighlight(container, idToSlugRef.current, activeSlug);
  }, [activeSlug]);

  // The large main-panel graph stops <main> from scrolling as a whole, so its
  // own scroll region owns both axes (mirrors how NoteView toggles note-view-main).
  useEffect(() => {
    if (variant !== 'main') return;
    const main = document.querySelector('main');
    main?.classList.add('graph-main');
    return () => main?.classList.remove('graph-main');
  }, [variant]);

  // Delegated: a click anywhere on a node group opens the corresponding note.
  const onClick = useCallback((e: MouseEvent) => {
    const g = (e.target as Element).closest('g.node');
    if (!g) return;
    const id = nodeIdFromElement(g);
    const slug = id ? idToSlugRef.current.get(id) : undefined;
    if (slug) navigate(`/notes/${slug}`);
  }, []);

  const main = variant === 'main';
  return (
    <div class={`sidebar-graph-wrap${main ? ' sidebar-graph-wrap--main' : ''}`}>
      {main && source && (
        <span class="sidebar-graph-info" title={source} aria-label="Mermaid source">
          <Icon name="info" size={16} />
        </span>
      )}
      {slowLoading && <p class="muted sidebar-graph-msg">Loading…</p>}
      {empty && !loading && <p class="muted sidebar-graph-msg">No linked notes yet.</p>}
      <div ref={containerRef} class={`sidebar-graph${main ? ' sidebar-graph--main' : ''}`} onClick={onClick} />
      {!empty && legend.length > 0 && (
        <ul class="sidebar-graph-legend" aria-label="Node colors by tag">
          {legend.map((e) => (
            <li key={e.label} class="sidebar-graph-legend-item">
              <span class="sidebar-graph-swatch" style={`background:${e.color}`} />
              {e.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
