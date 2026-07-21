import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api, type NoteSummary, type TagSummary, type SortField, type SortOrder } from '../api/client.js';
import { navigate, tagsPath } from '../router.js';
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
  activeTags: string[];
  listKey?: number;
  sortField: SortField;
  sortOrder: SortOrder;
  onSortChange: (field: SortField, order: SortOrder) => void;
}

export function NoteList({ activeSlug, activeTags, listKey, sortField, sortOrder, onSortChange }: Props) {
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
  const [allTags, setAllTags] = useState<TagSummary[]>([]);
  const shownRef = useRef(new Set<string>());
  const genRef = useRef(0);

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

  const loadPage = useCallback(async (q: string, tags: string[], prefix: boolean, pageOffset: number, gen: number) => {
    setLoading(true);
    const cappedQ = capRunes(q, MAX_Q_RUNES);
    // Clamp limit/offset to the ranges declared in openapi.yaml.
    const safeLimit = Math.max(1, Math.min(200, LIMIT));
    const safeOffset = Math.max(0, pageOffset);
    try {
      const res = await api.notes.list({
        q: cappedQ || undefined,
        tags,
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
  // tag filter, or listKey changes. tagKey collapses the tags array to a stable
  // string so a fresh array identity each render doesn't retrigger the load.
  const tagKey = activeTags.join(',');
  useEffect(() => {
    const gen = ++genRef.current;
    shownRef.current = new Set();
    setRows([]);
    setOffset(0);
    setTotal(null);
    setExhausted(false);
    void loadPage(debounced.q, activeTags, debounced.titlePrefix, 0, gen);
    // activeTags is keyed via tagKey.
  }, [debounced, tagKey, loadPage, listKey]);

  // Navigate to the note list filtered by the given tag set (AND). An empty set
  // clears the filter (back to "All notes").
  const setTagFilter = (tags: string[]) => navigate(tagsPath(tags));

  // Tags offered by the "add tag" picker: every known tag not already in the
  // active filter.
  const availableTags = allTags.filter(t => !activeTags.includes(t.slug));

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

      {(activeTags.length > 0 || allTags.length > 0) && (
        <div class="tag-filter-row tag-filter-row-tags">
          <span class="tag-filter-name">Tags</span>
          <div class="tag-filter-controls">
            {/* Active filters as removable chips. Multiple tags AND together:
                a note must carry every one. A chip may name a tag that has since
                been deleted (still in the URL); it stays removable regardless. */}
            {activeTags.length > 0 && (
              <div class="tag-chips">
                {activeTags.map(slug => (
                  <span key={slug} class="tag-chip">
                    {slug}
                    <button
                      type="button"
                      class="tag-chip-remove"
                      title={`Remove filter “${slug}”`}
                      aria-label={`Remove tag filter ${slug}`}
                      onClick={() => setTagFilter(activeTags.filter(t => t !== slug))}
                    >×</button>
                  </span>
                ))}
              </div>
            )}
            {availableTags.length > 0 && (
              <select
                class="tag-filter-select"
                value=""
                aria-label="Add tag filter"
                onChange={(e) => {
                  const slug = (e.target as HTMLSelectElement).value;
                  if (slug) setTagFilter([...activeTags, slug]);
                }}
              >
                <option value="">{activeTags.length ? 'Add another tag…' : 'Filter by tag…'}</option>
                {availableTags.map(t => (
                  <option key={t.slug} value={t.slug}>{t.slug}</option>
                ))}
              </select>
            )}
          </div>
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
          <button onClick={() => void loadPage(debounced.q, activeTags, debounced.titlePrefix, offset, genRef.current)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
