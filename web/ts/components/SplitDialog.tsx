import { useState, useEffect } from 'preact/hooks';
import { type Tag } from '../api/client.js';
import { TagPicker } from './TagPicker.js';
import { Icon } from './Icon.js';

interface Props {
  // Perform the split with the chosen tag slug (undefined = no tag).
  onSplit: (tag: string | undefined) => void;
  // Dismiss the dialog without splitting.
  onClose: () => void;
  // Disables the actions while a split is in flight.
  busy: boolean;
}

// Modal shown by the note read view's "Split" action. Lets the user optionally
// pick — or create — a single tag to assign to every note produced by the
// split, reusing the same TagPicker widget as the editor (so creating a new tag
// works the same way). Splitting with no tag is allowed: the picker just stays
// empty.
export function SplitDialog({ onSplit, onClose, busy }: Props) {
  // TagPicker is multi-select; the split assigns a single tag, so keep only the
  // most recently chosen one (selecting another replaces it).
  const [selected, setSelected] = useState<Tag[]>([]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const tag = selected[0]?.slug;

  return (
    <div class="split-overlay" onClick={busy ? undefined : onClose}>
      <div class="split-dialog" role="dialog" aria-modal="true" aria-labelledby="split-title"
        onClick={(e) => e.stopPropagation()}>
        <h2 id="split-title" class="split-title">Split note by headings</h2>
        <p class="split-body">
          Creates a separate note for each top-level heading. Optionally assign a
          tag to every new note.
        </p>
        {/* Once a tag is chosen the picker collapses to a single chip, so its
            suggestion dropdown never overlaps the action buttons below. Remove
            the chip to pick a different tag. */}
        {tag ? (
          <div class="split-tag-selected">
            <span class="tag-chip">
              {tag}
              <button type="button" class="tag-chip-remove" aria-label={`Remove tag ${tag}`}
                disabled={busy} onClick={() => setSelected([])}><Icon name="x" size={14} /></button>
            </span>
          </div>
        ) : (
          <TagPicker selected={[]} onChange={(next) => setSelected(next.slice(-1))} />
        )}
        <div class="split-actions">
          <button type="button" class="link" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" disabled={busy} onClick={() => onSplit(tag)}>
            {busy ? 'Splitting…' : tag ? `Split & tag “${tag}”` : 'Split'}
          </button>
        </div>
      </div>
    </div>
  );
}
