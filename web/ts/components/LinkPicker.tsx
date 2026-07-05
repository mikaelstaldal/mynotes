import { useState, useEffect, useRef } from 'preact/hooks';
import { api, type NoteSummary } from '../api/client.js';

interface Props {
  currentSlug: string | undefined;
  onSelect: (slug: string, title: string) => void;
  onClose: () => void;
}

export function LinkPicker({ currentSlug, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NoteSummary[]>([]);
  const [searching, setSearching] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape from anywhere in the document.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const list = await api.notes.list({ q: query || undefined, titleOnly: true, limit: 50 });
        setResults(list.notes.filter(n => n.slug !== currentSlug));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, currentSlug]);

  return (
    <div class="link-picker-overlay" onClick={onClose}>
      <div class="link-picker" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          class="link-picker-input"
          type="search"
          placeholder="Search notes…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {searching ? (
          <p class="link-picker-empty muted">Searching…</p>
        ) : results.length === 0 ? (
          <p class="link-picker-empty muted">No notes found</p>
        ) : (
          <ul class="link-picker-list">
            {results.map(n => (
              <li key={n.slug}>
                <button
                  type="button"
                  class="link-picker-item"
                  onClick={() => onSelect(n.slug, n.title)}
                >
                  {n.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
