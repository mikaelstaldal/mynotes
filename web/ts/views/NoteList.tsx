import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api, type NoteSummary } from '../api/client.js';
import { navigate } from '../router.js';
import { showToast } from '../util/toast.js';

const LIMIT = 50;
const MAX_Q_RUNES = 200;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Safety: escapeHtml runs first, so every character from the server-supplied
// excerpt is neutralized before any HTML is introduced. The only < > that
// survive are the two hardcoded literal strings below — never user content.
function renderExcerpt(excerpt: string): string {
  return escapeHtml(excerpt)
    .replace(/\x02/g, '<mark>')
    .replace(/\x03/g, '</mark>');
}

function capRunes(s: string, max: number): string {
  return [...s].slice(0, max).join('');
}

interface Props {
  activeSlug?: string;
  listKey?: number;
  onMutate?: () => void;
}

export function NoteList({ activeSlug, listKey, onMutate }: Props) {
  const [inputQuery, setInputQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const shownRef = useRef(new Set<string>());
  const genRef = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);

  // Commit inputQuery → debouncedQuery after 300 ms of no input.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(inputQuery), 300);
    return () => clearTimeout(id);
  }, [inputQuery]);

  const loadPage = useCallback(async (q: string, pageOffset: number, gen: number) => {
    setLoading(true);
    const cappedQ = capRunes(q, MAX_Q_RUNES);
    // Clamp limit/offset to the ranges declared in openapi.yaml.
    const safeLimit = Math.max(1, Math.min(200, LIMIT));
    const safeOffset = Math.max(0, pageOffset);
    try {
      const res = await api.notes.list({
        q: cappedQ || undefined,
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
  }, []);

  // Reset accumulated rows and offset whenever the debounced query or listKey changes.
  useEffect(() => {
    const gen = ++genRef.current;
    shownRef.current = new Set();
    setRows([]);
    setOffset(0);
    setTotal(null);
    setExhausted(false);
    void loadPage(debouncedQuery, 0, gen);
  }, [debouncedQuery, loadPage, listKey]);

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

      {total !== null && (
        <p class="result-count muted">{total} {total === 1 ? 'note' : 'notes'}</p>
      )}

      {loading && rows.length === 0 ? (
        <p class="muted">Loading…</p>
      ) : !loading && rows.length === 0 ? (
        <p class="muted">{debouncedQuery ? 'No matching notes.' : 'No notes yet.'}</p>
      ) : (
        <ul>
          {rows.map(n => (
            <li key={n.slug}>
              <div class={`note-row${n.slug === activeSlug ? ' note-row--active' : ''}`}>
                <a class="link" href={`/notes/${n.slug}`}>{n.title}</a>
                <time class="muted note-date" dateTime={n.updated_at}>
                  {new Date(n.updated_at).toLocaleString()}
                </time>
                {n.excerpt && (
                  <p class="note-excerpt muted"
                    dangerouslySetInnerHTML={{ __html: renderExcerpt(n.excerpt) }}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {loading && rows.length > 0 && <p class="muted">Loading…</p>}

      {showLoadMore && (
        <div class="load-more">
          <button onClick={() => void loadPage(debouncedQuery, offset, genRef.current)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
