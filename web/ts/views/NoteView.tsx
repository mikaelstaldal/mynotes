import { useState, useEffect, useMemo } from 'preact/hooks';
import { api, NotFoundError, type Note } from '../api/client.js';
import { navigate } from '../router.js';
import { base } from '../basepath.js';
import { showToast } from '../util/toast.js';
import { renderNote } from '../util/markdown.js';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

interface Props {
  slug: string;
  onDelete?: () => void;
}

export function NoteView({ slug, onDelete }: Props) {
  const [note, setNote] = useState<Note | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setNote(null);
    (async () => {
      try {
        const fetched = await api.notes.get(slug);
        if (cancelled) return;
        setNote(fetched);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof NotFoundError) {
          setNotFound(true);
        } else {
          showToast(`Failed to load: ${(e as Error).message}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (!note) return;
    const prev = document.title;
    document.title = note.title;
    return () => { document.title = prev; };
  }, [note]);

  const renderedContent = useMemo(() => {
    if (!note) return '';
    return renderNote(note.content);
  }, [note]);

  async function handleDelete() {
    if (!note) return;
    if (!confirm(`Delete “${note.title}”? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.notes.delete(note.slug);
      onDelete?.();
      navigate('/');
    } catch (e) {
      if (e instanceof NotFoundError) {
        showToast('Note was already deleted');
        onDelete?.();
        navigate('/');
      } else {
        showToast(`Failed to delete: ${(e as Error).message}`);
        setDeleting(false);
      }
    }
  }

  if (loading) return <p class="muted">Loading…</p>;

  if (notFound) {
    return (
      <div class="note-view">
        <p class="muted">Note not found.</p>
      </div>
    );
  }

  if (!note) return null;

  return (
    <div class="note-view">
      <div class="note-header">
        <div class="note-header-left">
          <h1 class="note-title">{note.title}</h1>
          <span class="muted note-view-date">
            <time dateTime={note.created_at}>created {formatDateTime(note.created_at)}</time>
            {' · '}
            <time dateTime={note.updated_at}>updated {formatDateTime(note.updated_at)}</time>
            {' · v'}{note.version}
          </span>
          {note.tags.length > 0 && (
            <div class="tag-chips">
              {note.tags.map(t => (
                <a key={t.slug} class="tag-chip" href={`${base}/tags/${t.slug}`}>{t.name}</a>
              ))}
            </div>
          )}
        </div>
        <div class="toolbar">
          <a class="btn-icon" href={`${base}/api/v1/notes/${note.slug}/download-markdown`} title="Download Markdown" aria-label="Download Markdown">⬇</a>
          <a class="btn-icon" href={`${base}/api/v1/notes/${note.slug}/download-html`} title="Download HTML" aria-label="Download HTML">&#x1F5CE;</a>
          <button class="btn-icon" title="Edit" aria-label="Edit" onClick={() => navigate(`/notes/${note.slug}/edit`)}>✎</button>
          <button class="danger btn-icon" onClick={handleDelete} disabled={deleting}
            title={deleting ? 'Deleting…' : 'Delete'} aria-label={deleting ? 'Deleting…' : 'Delete'}>
            🗑
          </button>
        </div>
      </div>
      <div class="note-content" dangerouslySetInnerHTML={{ __html: renderedContent }} />
    </div>
  );
}
