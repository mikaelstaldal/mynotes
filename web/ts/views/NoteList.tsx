import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api, NotFoundError, type NoteSummary, type Tag, type SortField, type SortOrder } from '../api/client.js';
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
  // Two mutually-exclusive search inputs: a full-text query over content+title,
  // and an autocomplete-style case-insensitive prefix filter on the title only.
  // Typing in one clears the other; the title filter takes precedence when both
  // somehow hold text.
  const [textInput, setTextInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [debounced, setDebounced] = useState<{ q: string; titlePrefix: boolean }>({ q: '', titlePrefix: false });
  const titleMode = titleInput.trim() !== '';
  // Sort only applies to the browse list; the backend ignores it for both
  // full-text (relevance-ordered) and title-prefix (title-ordered) searches.
  const searchActive = titleMode || textInput.trim() !== '';
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [removingTag, setRemovingTag] = useState(false);
  const shownRef = useRef(new Set<string>());
  const genRef = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);

  // Commit the active input → debounced {query, mode} after 300 ms of no input.
  // The title filter wins when it holds text; otherwise the full-text query
  // applies (empty means "browse all").
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(titleInput.trim()
        ? { q: titleInput, titlePrefix: true }
        : { q: textInput, titlePrefix: false });
    }, 300);
    return () => clearTimeout(id);
  }, [textInput, titleInput]);

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

  const loadPage = useCallback(async (q: string, tag: string | undefined, prefix: boolean, pageOffset: number, gen: number) => {
    setLoading(true);
    const cappedQ = capRunes(q, MAX_Q_RUNES);
    // Clamp limit/offset to the ranges declared in openapi.yaml.
    const safeLimit = Math.max(1, Math.min(200, LIMIT));
    const safeOffset = Math.max(0, pageOffset);
    try {
      const res = await api.notes.list({
        q: cappedQ || undefined,
        tag,
        titlePrefix: prefix,
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

  // Reset accumulated rows and offset whenever the debounced query, match mode,
  // tag filter, or listKey changes.
  useEffect(() => {
    const gen = ++genRef.current;
    shownRef.current = new Set();
    setRows([]);
    setOffset(0);
    setTotal(null);
    setExhausted(false);
    void loadPage(debounced.q, activeTag, debounced.titlePrefix, 0, gen);
  }, [debounced, activeTag, loadPage, listKey]);

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

  // Remove the currently-filtered tag. The server detaches it from every note
  // (the notes themselves are kept), so this works whether the tag is empty or
  // still attached to notes. Afterwards drop the filter and refresh the list so
  // the deleted tag disappears from the dropdown.
  //
  // Confirm only when the tag still carries notes: an empty tag has nothing to
  // lose, so removing it is a no-cost action. Count with a dedicated query
  // (limit 0, just the total) so any active search/title filter doesn't skew it;
  // if the count can't be fetched, err on the side of confirming.
  async function handleRemoveTag() {
    if (!activeTag) return;
    let hasNotes = true;
    try {
      const res = await api.notes.list({ tag: activeTag, limit: 1, offset: 0 });
      hasNotes = res.total > 0;
    } catch {
      // Leave hasNotes = true so we still confirm.
    }
    if (hasNotes && !confirm(`Remove tag “${activeTag}”? Notes with this tag are kept, but will no longer carry it.`)) return;
    setRemovingTag(true);
    try {
      await api.tags.delete(activeTag);
    } catch (e) {
      if (!(e instanceof NotFoundError)) {
        showToast(`Failed to remove tag: ${(e as Error).message}`);
        setRemovingTag(false);
        return;
      }
      // Already gone: fall through to clear the filter and refresh.
    }
    setRemovingTag(false);
    navigate('/');
    onMutate?.();
  }

  const showLoadMore = !exhausted && total !== null && rows.length < total && !loading;

  return (
    <div class="item-list">
      <div class="toolbar">
        <input
          type="search"
          placeholder="Full-text search…"
          aria-label="Full-text search"
          value={textInput}
          onInput={e => {
            const v = (e.target as HTMLInputElement).value;
            setTextInput(v);
            if (v) setTitleInput('');
          }}
        />
        <input
          type="search"
          placeholder="Filter titles…"
          aria-label="Filter by title"
          value={titleInput}
          onInput={e => {
            const v = (e.target as HTMLInputElement).value;
            setTitleInput(v);
            if (v) setTextInput('');
          }}
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
            disabled={searchActive}
            title={searchActive
              ? (titleMode ? 'Title matches are always ordered by title' : 'Search results are ordered by relevance')
              : undefined}
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
          {activeTag && (
            <button
              class="danger btn-icon"
              onClick={handleRemoveTag}
              disabled={removingTag}
              title={removingTag ? 'Removing tag…' : `Remove tag “${activeTag}”`}
              aria-label={removingTag ? 'Removing tag…' : `Remove tag “${activeTag}”`}
            >❌︎</button>
          )}
        </div>
      )}

      {total !== null && (
        <p class="result-count muted">{total} {total === 1 ? 'note' : 'notes'}</p>
      )}

      {loading && rows.length === 0 ? (
        <p class="muted">Loading…</p>
      ) : !loading && rows.length === 0 ? (
        <p class="muted">{debounced.q ? 'No matching notes.' : 'No notes yet.'}</p>
      ) : (
        <NoteRows rows={rows} activeSlug={activeSlug} />
      )}

      {loading && rows.length > 0 && <p class="muted">Loading…</p>}

      {showLoadMore && (
        <div class="load-more">
          <button onClick={() => void loadPage(debounced.q, activeTag, debounced.titlePrefix, offset, genRef.current)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
