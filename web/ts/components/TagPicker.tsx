import { useState, useEffect, useRef } from 'preact/hooks';
import { api, type Tag } from '../api/client.js';
import { showToast } from '../util/toast.js';

interface Props {
  selected: Tag[];
  onChange: (tags: Tag[]) => void;
}

// Inline multi-select tag input: existing tags are suggested via a
// client-side-filtered dropdown (small dataset, no server-side search
// needed), and creating a brand new tag is a separate, visually distinct
// action below the real matches — never the default choice — so the UI
// nudges toward reusing tags instead of spawning near-duplicates.
export function TagPicker({ selected, onChange }: Props) {
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.tags.list();
        setAllTags(list.tags);
      } catch (e) {
        showToast(`Failed to load tags: ${(e as Error).message}`);
      }
    })();
  }, []);

  const selectedSlugs = new Set(selected.map(t => t.slug));
  const trimmedQuery = query.trim();
  const matches = trimmedQuery
    ? allTags.filter(t =>
      !selectedSlugs.has(t.slug) && t.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
    : allTags.filter(t => !selectedSlugs.has(t.slug));
  const exactMatch = allTags.some(t => t.name.toLowerCase() === trimmedQuery.toLowerCase());
  const canCreate = trimmedQuery.length > 0 && !exactMatch;

  function addTag(tag: Tag) {
    onChange([...selected, tag]);
    setQuery('');
    inputRef.current?.focus();
  }

  function removeTag(slug: string) {
    onChange(selected.filter(t => t.slug !== slug));
  }

  async function createAndAddTag() {
    if (!trimmedQuery || creating) return;
    setCreating(true);
    try {
      const tag = await api.tags.create({ name: trimmedQuery });
      setAllTags(prev => [...prev, tag]);
      addTag(tag);
    } catch (e) {
      showToast(`Failed to create tag: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div class="tag-picker">
      {selected.length > 0 && (
        <div class="tag-chips">
          {selected.map(t => (
            <span key={t.slug} class="tag-chip">
              {t.name}
              <button type="button" class="tag-chip-remove" aria-label={`Remove tag ${t.name}`}
                onClick={() => removeTag(t.slug)}>×</button>
            </span>
          ))}
        </div>
      )}
      <div class="tag-picker-input-wrap">
        <input
          ref={inputRef}
          type="text"
          class="tag-picker-input"
          placeholder="Add tag…"
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQuery(''); inputRef.current?.blur(); }
            if (e.key === 'Enter') { e.preventDefault(); if (matches.length > 0) addTag(matches[0]); else void createAndAddTag(); }
          }}
        />
        {open && (matches.length > 0 || canCreate) && (
          // onMouseDown here (before the input's onBlur fires) keeps focus on
          // the input so a click on an option registers instead of racing a
          // blur-triggered close.
          <ul class="tag-picker-dropdown" onMouseDown={(e) => e.preventDefault()}>
            {matches.map(t => (
              <li key={t.slug}>
                <button type="button" class="tag-picker-option" onClick={() => addTag(t)}>
                  {t.name}
                </button>
              </li>
            ))}
            {canCreate && (
              <li>
                <button type="button" class="tag-picker-create" disabled={creating}
                  onClick={() => void createAndAddTag()}>
                  {creating ? 'Creating…' : `+ Create tag "${trimmedQuery}"`}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
