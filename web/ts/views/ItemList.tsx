import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type NoteSummary } from '../api/client.js';
import { navigate } from '../router.js';
import { showToast } from '../util/toast.js';

export function ItemList() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await api.notes.list({ q: q || undefined });
      setNotes(res.notes);
    } catch (e) {
      showToast(`Failed to load notes: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(query); }, [query, load]);

  async function handleDelete(slug: string) {
    try {
      await api.notes.delete(slug);
      setNotes(notes => notes.filter(n => n.slug !== slug));
    } catch (e) {
      showToast(`Failed to delete: ${(e as Error).message}`);
    }
  }

  return (
    <div class="item-list">
      <div class="toolbar">
        <input
          type="search"
          placeholder="Search…"
          value={query}
          onInput={e => setQuery((e.target as HTMLInputElement).value)}
        />
        <button class="primary" onClick={() => navigate('/new')}>New note</button>
      </div>

      {loading ? (
        <p class="muted">Loading…</p>
      ) : notes.length === 0 ? (
        <p class="muted">No notes yet.</p>
      ) : (
        <ul>
          {notes.map(n => (
            <li key={n.slug}>
              <a href={`/notes/${n.slug}`}>{n.title}</a>
              <span class="muted">{new Date(n.updated_at).toLocaleString()}</span>
              <button class="danger" onClick={() => handleDelete(n.slug)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
