import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api, type NoteSummary, type SortField, type SortOrder } from '../api/client.js';
import { showToast } from '../util/toast.js';
import { NoteRows } from './NoteRows.js';

const LIMIT = 50;

interface Props {
  activeTags: string[];
  listKey?: number;
  onMutate?: () => void;
  sortField: SortField;
  sortOrder: SortOrder;
}

// Main-panel overview shown when no note is selected. Lists every note (or every
// note carrying all of the active tags). Falls back to a prompt only when the
// list is genuinely empty.
export function NotesOverview({ activeTags, listKey, onMutate, sortField, sortOrder }: Props) {
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const shownRef = useRef(new Set<string>());
  const genRef = useRef(0);

  const loadPage = useCallback(async (tags: string[], pageOffset: number, gen: number) => {
    setLoading(true);
    const safeOffset = Math.max(0, pageOffset);
    try {
      const res = await api.notes.list({ tags, sort: sortField, order: sortOrder, limit: LIMIT, offset: safeOffset });
      if (genRef.current !== gen) return;
      setTotal(res.total);
      if (res.notes.length === 0) {
        setExhausted(true);
      } else {
        const fresh = res.notes.filter(r => !shownRef.current.has(r.slug));
        fresh.forEach(r => shownRef.current.add(r.slug));
        const newOffset = safeOffset + res.notes.length;
        setRows(prev => [...prev, ...fresh]);
        setOffset(newOffset);
        if (newOffset >= res.total) setExhausted(true);
      }
    } catch (e) {
      if (genRef.current !== gen) return;
      showToast(`Failed to load notes: ${(e as Error).message}`);
    } finally {
      if (genRef.current === gen) setLoading(false);
    }
  }, [sortField, sortOrder]);

  // Reset accumulated rows whenever the tag filter or listKey changes. tagKey
  // collapses the tags array to a stable string so a fresh array identity each
  // render doesn't retrigger the load.
  const tagKey = activeTags.join(',');
  useEffect(() => {
    const gen = ++genRef.current;
    shownRef.current = new Set();
    setRows([]);
    setOffset(0);
    setTotal(null);
    setExhausted(false);
    void loadPage(activeTags, 0, gen);
    // activeTags is keyed via tagKey; loadPage is stable per sort field/order.
  }, [tagKey, loadPage, listKey]);

  const showLoadMore = !exhausted && total !== null && rows.length < total && !loading;

  // A tag's slug is its display label; when several are active the heading joins
  // them to reflect the AND filter.
  const heading = activeTags.length ? activeTags.join(' + ') : 'All notes';

  if (loading && rows.length === 0) {
    return <p class="muted">Loading…</p>;
  }

  if (!loading && rows.length === 0) {
    return <p class="muted select-prompt">Select a note or create a new one.</p>;
  }

  return (
    <div class="item-list">
      <h1 class="note-title overview-heading">{heading}</h1>
      <NoteRows rows={rows} showActions onMutate={onMutate} />
      {loading && rows.length > 0 && <p class="muted">Loading…</p>}
      {showLoadMore && (
        <div class="load-more">
          <button onClick={() => void loadPage(activeTags, offset, genRef.current)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
