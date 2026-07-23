import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type TagSummary } from '../api/client.js';
import { showToast } from '../util/toast.js';
import { useSlowLoading } from '../util/loading.js';
import { Icon } from '../components/Icon.js';

interface Props {
  // Bumped by the app whenever notes/tags change elsewhere, so the counts here
  // stay in step with the rest of the UI.
  listKey?: number;
  // Called after a tag is deleted so the note list and tag filters elsewhere
  // refresh (a deleted tag detaches from every note it was on).
  onMutate?: () => void;
  // Open the note list filtered by a single tag. The app also switches the
  // sidebar back to the notes tab so the filtered result is visible.
  onOpenTag?: (slug: string) => void;
}

export function TagManager({ listKey, onMutate, onOpenTag }: Props) {
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Delayed mirror of `loading` for the visible indicator; see util/loading.ts.
  const slowLoading = useSlowLoading(loading);
  // Slug currently being deleted, so its row's button can disable itself and we
  // don't fire overlapping deletes.
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.tags.list();
      setTags(list.tags);
    } catch (e) {
      showToast(`Failed to load tags: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, listKey]);

  const handleDelete = async (tag: TagSummary) => {
    // An empty tag deletes silently; one still attached to notes asks first,
    // since deleting it detaches it from those notes.
    if (tag.note_count > 0) {
      const noun = tag.note_count === 1 ? 'note' : 'notes';
      const ok = confirm(
        `Delete tag “${tag.slug}”? It is attached to ${tag.note_count} ${noun}, ` +
        `which will be untagged. This cannot be undone.`);
      if (!ok) return;
    }
    setDeleting(tag.slug);
    try {
      await api.tags.delete(tag.slug);
      onMutate?.();
      await load();
    } catch (e) {
      showToast(`Failed to delete tag: ${(e as Error).message}`);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div class="item-list tag-list">
      {tags.length === 0 ? (
        // Quick loads stay blank; the indicator (and the empty-state text) only
        // appear once the load has outlasted the delay / actually settled.
        slowLoading ? (
          <p class="muted">Loading…</p>
        ) : loading ? null : (
          <p class="muted">No tags yet.</p>
        )
      ) : (
        <ul class="tag-manager-list">
          {tags.map(tag => (
            <li key={tag.slug} class="tag-manager-row">
              <button
                type="button"
                class="link tag-manager-name"
                title={`Filter notes by “${tag.slug}”`}
                onClick={() => onOpenTag?.(tag.slug)}
              >{tag.slug}</button>
              <span class="tag-manager-count muted">
                {tag.note_count} {tag.note_count === 1 ? 'note' : 'notes'}
              </span>
              <button
                class="danger btn-icon tag-manager-delete"
                title={`Delete tag “${tag.slug}”`}
                aria-label={`Delete tag ${tag.slug}`}
                disabled={deleting === tag.slug}
                onClick={() => void handleDelete(tag)}
              ><Icon name="recycle" size={16} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
