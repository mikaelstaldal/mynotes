import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { LUCIDE_ICONS, LUCIDE_CATEGORIES, type IconMeta } from 'lucide-icons';
import { Icon } from './Icon.js';

// The full set is ~1700 inline SVGs; mounting them all at once is sluggish. Cap
// the rendered grid and, when more match, hide the surplus behind a hint that
// prompts the user to narrow the search. Category browsing stays well under this
// (the largest category is ~260 icons), so the cap only bites the widest ones.
const MAX_SHOWN = 240;

interface Props {
  onSelect: (name: string) => void;
  onClose: () => void;
}

// Kebab name → human-readable label for the tooltip ("circle-alert" → "circle alert").
function label(name: string): string {
  return name.replace(/-/g, ' ');
}

export function IconPicker({ onSelect, onClose }: Props) {
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

  // When searching, match the query against every icon's name + keywords across
  // all categories; otherwise browse the active category's icons (both capped
  // below). Mirrors the emoji picker's search-vs-browse split.
  const matches: IconMeta[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const names = new Set(LUCIDE_CATEGORIES[activeCategory].icons);
      return LUCIDE_ICONS.filter((ic) => names.has(ic.name));
    }
    return LUCIDE_ICONS.filter((ic) => ic.name.includes(q) || ic.keywords.includes(q));
  }, [query, activeCategory]);

  const shown = matches.slice(0, MAX_SHOWN);
  const hidden = matches.length - shown.length;

  return (
    <div class="icon-picker-overlay" onClick={onClose}>
      <div class="icon-picker" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          class="icon-picker-input"
          type="search"
          placeholder="Search icons…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {!query.trim() && (
          <div class="icon-picker-tabs">
            {LUCIDE_CATEGORIES.map((cat, i) => (
              <button
                key={cat.name}
                type="button"
                class={i === activeCategory ? 'icon-picker-tab active' : 'icon-picker-tab'}
                title={cat.name}
                aria-label={cat.name}
                onClick={() => setActiveCategory(i)}
              >
                <Icon name={cat.icon} size={18} />
              </button>
            ))}
          </div>
        )}
        {shown.length === 0 ? (
          <p class="icon-picker-empty muted">No icons found</p>
        ) : (
          <div class="icon-picker-grid">
            {shown.map((ic) => (
              <button
                key={ic.name}
                type="button"
                class="icon-picker-item"
                title={label(ic.name)}
                aria-label={label(ic.name)}
                onClick={() => onSelect(ic.name)}
              >
                <Icon name={ic.name} size={22} />
              </button>
            ))}
          </div>
        )}
        {hidden > 0 && (
          <p class="icon-picker-more muted">+{hidden} more — refine your search</p>
        )}
      </div>
    </div>
  );
}
