import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api, type NoteSummary, type Tag, type SortField, type SortOrder } from '../api/client.js';
import { navigate } from '../router.js';
import { showToast } from '../util/toast.js';
import { NoteRows } from './NoteRows.js';

const LIMIT = 50;
const MAX_Q_RUNES = 200;

function capRunes(s: string, max: number): string {
  return [...s].slice(0, max).join('');
}

// Combined "field:order" values for the single sort <select>, paired with the
// label shown to the user. Order matters: this is the option list.
const SORT_OPTIONS: { value: `${SortField}:${SortOrder}`; label: string }[] = [
  { value: 'updated:desc', label: 'Updated (newest)' },
  { value: 'updated:asc', label: 'Updated (oldest)' },
  { value: 'created:desc', label: 'Created (newest)' },
  { value: 'created:asc', label: 'Created (oldest)' },
  { value: 'title:asc', label: 'Title (A–Z)' },
  { value: 'title:desc', label: 'Title (Z–A)' },
];

interface Props {
  activeSlug?: string;
  activeTag?: string;
  listKey?: number;
  onMutate?: () => void;
  sortField: SortField;
  sortOrder: SortOrder;
  onSortChange: (field: SortField, order: SortOrder) => void;
}

export function NoteList({ activeSlug, activeTag, listKey, onMutate, sortField, sortOrder, onSortChange }: Props) {
  const [inputQuery, setInputQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const shownRef = useRef(new Set<string>());
  const genRef = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);

  // Commit inputQuery → debouncedQuery after 300 ms of no input.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(inputQuery), 300);
    return () => clearTimeout(id);
  }, [inputQuery]);

  // Load the full tag list (independent of which notes are currently shown)
  // so the filter dropdown can offer every tag, not just ones visible in the
  // loaded page. Re-fetched on listKey change so a tag created elsewhere
  // (e.g. in the editor) shows up after the next note-list refresh.
  useEffect(() => {
    (async () => {
      try {
        const list = await api.tags.list();
        setAllTags(list.tags);
      } catch (e) {
        showToast(`Failed to load tags: ${(e as Error).message}`);
      }
    })();
  }, [listKey]);

  const loadPage = useCallback(async (q: string, tag: string | undefined, pageOffset: number, gen: number) => {
    setLoading(true);
    const cappedQ = capRunes(q, MAX_Q_RUNES);
    // Clamp limit/offset to the ranges declared in openapi.yaml.
    const safeLimit = Math.max(1, Math.min(200, LIMIT));
    const safeOffset = Math.max(0, pageOffset);
    try {
      const res = await api.notes.list({
        q: cappedQ || undefined,
        tag,
        sort: sortField,
        order: sortOrder,
        limit: safeLimit,
        offset: safeOffset,
      });
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

  // Reset accumulated rows and offset whenever the debounced query, tag filter,
  // or listKey changes.
  useEffect(() => {
    const gen = ++genRef.current;
    shownRef.current = new Set();
    setRows([]);
    setOffset(0);
    setTotal(null);
    setExhausted(false);
    void loadPage(debouncedQuery, activeTag, 0, gen);
  }, [debouncedQuery, activeTag, loadPage, listKey]);

  async function handleUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();

    if ([...text].length > 1_000_000) {
      showToast('File too large: must be at most 1,000,000 characters.');
      if (uploadRef.current) uploadRef.current.value = '';
      return;
    }

    const isHtml = /\.html?$/i.test(file.name) || file.type === 'text/html';
    try {
      let note;
      if (isHtml) {
        note = await api.notes.importHtml(text);
      } else {
        note = await api.notes.importMarkdown(text);
      }
      onMutate?.();
      navigate(`/notes/${note.slug}`);
    } catch (err) {
      showToast(`Upload failed: ${(err as Error).message}`);
    }
    // Reset so the same file can be re-uploaded.
    if (uploadRef.current) uploadRef.current.value = '';
  }

  const showLoadMore = !exhausted && total !== null && rows.length < total && !loading;

  return (
    <div class="item-list">
      <div class="toolbar">
        <input
          type="search"
          placeholder="Search…"
          value={inputQuery}
          onInput={e => setInputQuery((e.target as HTMLInputElement).value)}
        />
        <button class="btn-icon" title="Reload list" aria-label="Reload list" onClick={() => onMutate?.()}>↺</button>
        <button class="primary btn-icon" title="New note" aria-label="New note" onClick={() => navigate('/new')}>+</button>
        <button class="btn-icon" title="Upload note (Markdown or HTML)" aria-label="Upload note" onClick={() => uploadRef.current?.click()}>⬆</button>
        <input
          ref={uploadRef}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain,.html,.htm,text/html"
          style="display:none"
          onChange={handleUpload}
        />
      </div>

      <div class="tag-filter-row">
        <label class="tag-filter-label">
          <span class="tag-filter-name">Sort</span>
          <select
            class="tag-filter-select"
            value={`${sortField}:${sortOrder}`}
            onChange={(e) => {
              const [field, order] = (e.target as HTMLSelectElement).value.split(':') as [SortField, SortOrder];
              onSortChange(field, order);
            }}
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      {allTags.length > 0 && (
        <div class="tag-filter-row">
          <label class="tag-filter-label">
            <span class="tag-filter-name">Tag</span>
            <select
              class="tag-filter-select"
              value={activeTag ?? ''}
              onChange={(e) => {
                const slug = (e.target as HTMLSelectElement).value;
                navigate(slug ? `/tags/${slug}` : '/');
              }}
            >
              <option value="">All tags</option>
              {allTags.map(t => (
                <option key={t.slug} value={t.slug}>{t.slug}</option>
              ))}
              {/* A filter active for a tag that has since been deleted: keep it
                  selectable (as its slug) so the dropdown reflects reality
                  instead of silently snapping back to "All tags". */}
              {activeTag && !allTags.some(t => t.slug === activeTag) && (
                <option value={activeTag}>{activeTag}</option>
              )}
            </select>
          </label>
        </div>
      )}

      {total !== null && (
        <p class="result-count muted">{total} {total === 1 ? 'note' : 'notes'}</p>
      )}

      {loading && rows.length === 0 ? (
        <p class="muted">Loading…</p>
      ) : !loading && rows.length === 0 ? (
        <p class="muted">{debouncedQuery ? 'No matching notes.' : 'No notes yet.'}</p>
      ) : (
        <NoteRows rows={rows} activeSlug={activeSlug} />
      )}

      {loading && rows.length > 0 && <p class="muted">Loading…</p>}

      {showLoadMore && (
        <div class="load-more">
          <button onClick={() => void loadPage(debouncedQuery, activeTag, offset, genRef.current)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
