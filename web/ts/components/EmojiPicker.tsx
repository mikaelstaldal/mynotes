import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { EMOJI_CATEGORIES, type Emoji } from 'emoji-data';

interface Props {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(0);
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

  // When searching, match across all categories on name + keywords; otherwise
  // show the active category's emoji.
  const shown: Emoji[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EMOJI_CATEGORIES[activeCategory].emojis;
    const seen = new Set<string>();
    const out: Emoji[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      for (const e of cat.emojis) {
        if (seen.has(e.char)) continue;
        if (e.name.includes(q) || (e.keywords?.includes(q) ?? false)) {
          seen.add(e.char);
          out.push(e);
        }
      }
    }
    return out;
  }, [query, activeCategory]);

  return (
    <div class="emoji-picker-overlay" onClick={onClose}>
      <div class="emoji-picker" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          class="emoji-picker-input"
          type="search"
          placeholder="Search emoji…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {!query.trim() && (
          <div class="emoji-picker-tabs">
            {EMOJI_CATEGORIES.map((cat, i) => (
              <button
                key={cat.name}
                type="button"
                class={i === activeCategory ? 'emoji-picker-tab active' : 'emoji-picker-tab'}
                title={cat.name}
                aria-label={cat.name}
                onClick={() => setActiveCategory(i)}
              >
                {cat.icon}
              </button>
            ))}
          </div>
        )}
        {shown.length === 0 ? (
          <p class="emoji-picker-empty muted">No emoji found</p>
        ) : (
          <div class="emoji-picker-grid">
            {shown.map(e => (
              <button
                key={e.char}
                type="button"
                class="emoji-picker-item"
                title={e.name}
                aria-label={e.name}
                onClick={() => onSelect(e.char)}
              >
                {e.char}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
