import { useState, useEffect } from 'preact/hooks';
import { api, NotFoundError } from '../api/client.js';
import { navigate } from '../router.js';
import { showToast } from '../util/toast.js';

interface Props {
  // undefined → creating a new item; a number → editing an existing one.
  id?: number;
}

export function ItemForm({ id }: Props) {
  const editing = id !== undefined;
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    (async () => {
      try {
        const item = await api.items.get(id);
        if (cancelled) return;
        setTitle(item.title);
        setContent(item.content);
      } catch (e) {
        if (e instanceof NotFoundError) {
          showToast('Item not found');
          navigate('#/');
        } else {
          showToast(`Failed to load: ${(e as Error).message}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, editing]);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await api.items.update(id, { title, content });
      } else {
        await api.items.create({ title, content });
      }
      navigate('#/');
    } catch (e) {
      showToast(`Failed to save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p class="muted">Loading…</p>;

  return (
    <form class="item-form" onSubmit={handleSubmit}>
      <h2>{editing ? 'Edit item' : 'New item'}</h2>
      <label>
        Title
        <input
          type="text"
          value={title}
          required
          maxLength={200}
          onInput={e => setTitle((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        Content (HTML)
        <textarea
          rows={6}
          value={content}
          onInput={e => setContent((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <div class="form-actions">
        <button type="button" onClick={() => navigate('#/')}>Cancel</button>
        <button type="submit" class="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
