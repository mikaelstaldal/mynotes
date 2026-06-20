import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type Item } from '../api/client.js';
import { navigate } from '../router.js';
import { showToast } from '../util/toast.js';

export function ItemList() {
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await api.items.list({ q: q || undefined });
      setItems(res.items);
    } catch (e) {
      showToast(`Failed to load items: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(query); }, [query, load]);

  async function handleDelete(id: number) {
    try {
      await api.items.delete(id);
      setItems(items => items.filter(it => it.id !== id));
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
        <button class="primary" onClick={() => navigate('#/new')}>New item</button>
      </div>

      {loading ? (
        <p class="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p class="muted">No items yet.</p>
      ) : (
        <ul>
          {items.map(it => (
            <li key={it.id}>
              <button class="link" onClick={() => navigate(`#/items/${it.id}`)}>{it.title}</button>
              <span class="muted">{new Date(it.updated_at).toLocaleString()}</span>
              <button class="danger" onClick={() => handleDelete(it.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
