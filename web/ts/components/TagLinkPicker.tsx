import { useState, useEffect, useRef } from 'preact/hooks';
import { api, type Tag } from '../api/client.js';
import { useSlowLoading } from '../util/loading.js';

interface Props {
  onSelect: (slug: string) => void;
  onClose: () => void;
}

// Modal picker for inserting a tag link ([[#slug]]) into a note. Tags are a
// small dataset, so the full list is loaded once and filtered client-side
// (same approach as TagPicker) with a case-insensitive prefix match on the tag
// slug (autocomplete style). Selecting a tag inserts a link to /tags/<slug>.
export function TagLinkPicker({ onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  // Delayed mirror of `loading` for the visible indicator; see util/loading.ts.
  const slowLoading = useSlowLoading(loading);
  const inputRef = useRef<HTMLInputElement>(null);

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
    (async () => {
      try {
        const list = await api.tags.list();
        setAllTags(list.tags);
      } catch {
        setAllTags([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const trimmed = query.trim().toLowerCase();
  const results = trimmed
    ? allTags.filter(t => t.slug.startsWith(trimmed))
    : allTags;

  return (
    <div class="link-picker-overlay" onClick={onClose}>
      <div class="link-picker" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          class="link-picker-input"
          type="search"
          placeholder="Search tags…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {slowLoading ? (
          <p class="link-picker-empty muted">Loading…</p>
        ) : loading ? null : results.length === 0 ? (
          <p class="link-picker-empty muted">No tags found</p>
        ) : (
          <ul class="link-picker-list">
            {results.map(t => (
              <li key={t.slug}>
                <button
                  type="button"
                  class="link-picker-item"
                  onClick={() => onSelect(t.slug)}
                >
                  {t.slug}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
