import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api, type NoteSummary, type SortField, type SortOrder } from '../api/client.js';
import { showToast } from '../util/toast.js';
import { NoteRows } from './NoteRows.js';

const LIMIT = 50;

interface Props {
  activeTag?: string;
  listKey?: number;
  sortField: SortField;
  sortOrder: SortOrder;
}

// Main-panel overview shown when no note is selected. Lists every note (or every
// note carrying the active tag). Falls back to a prompt only when the list is
// genuinely empty.
export function NotesOverview({ activeTag, listKey, sortField, sortOrder }: Props) {
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const shownRef = useRef(new Set<string>());
  const genRef = useRef(0);

  const loadPage = useCallback(async (tag: string | undefined, pageOffset: number, gen: number) => {
    setLoading(true);
    const safeOffset = Math.max(0, pageOffset);
    try {
      const res = await api.notes.list({ tag, sort: sortField, order: sortOrder, limit: LIMIT, offset: safeOffset });
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

  // Reset accumulated rows whenever the tag filter or listKey changes.
  useEffect(() => {
    const gen = ++genRef.current;
    shownRef.current = new Set();
    setRows([]);
    setOffset(0);
    setTotal(null);
    setExhausted(false);
    void loadPage(activeTag, 0, gen);
  }, [activeTag, loadPage, listKey]);

  const showLoadMore = !exhausted && total !== null && rows.length < total && !loading;

  // A tag's slug is its display label, so the active-tag filter heading is just
  // the slug itself.
  const heading = activeTag || 'All notes';

  if (loading && rows.length === 0) {
    return <p class="muted">Loading…</p>;
  }

  if (!loading && rows.length === 0) {
    return <p class="muted select-prompt">Select a note or create a new one.</p>;
  }

  return (
    <div class="item-list">
      <h1 class="note-title overview-heading">{heading}</h1>
      <NoteRows rows={rows} />
      {loading && rows.length > 0 && <p class="muted">Loading…</p>}
      {showLoadMore && (
        <div class="load-more">
          <button onClick={() => void loadPage(activeTag, offset, genRef.current)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
