import { useState, useEffect, useMemo } from 'preact/hooks';
import { api, NotFoundError, type Note } from '../api/client.js';
import { navigate } from '../router.js';
import { base } from '../basepath.js';
import { showToast } from '../util/toast.js';
import { renderNote } from '../util/markdown.js';
import { downloadNoteHtml } from '../util/exporthtml.js';

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
  const [exporting, setExporting] = useState(false);

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

  // HTML export runs client-side (unlike Markdown download, a plain link to the
  // server) so AsciiMath is rendered to MathML via the same path as the on-screen
  // view; the server download-html endpoint keeps the literal $…$ source.
  async function handleDownloadHtml() {
    if (!note) return;
    setExporting(true);
    try {
      await downloadNoteHtml(note);
    } catch (e) {
      showToast(`Failed to export HTML: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

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
          <span class="muted note-view-date" title={`Version ${note.version}`}>
            <time dateTime={note.created_at}>created {formatDateTime(note.created_at)}</time>
            {' · '}
            <time dateTime={note.updated_at}>updated {formatDateTime(note.updated_at)}</time>
          </span>
          {note.tags.length > 0 && (
            <div class="tag-chips">
              {note.tags.map(t => (
                <a key={t.slug} class="tag-chip" href={`${base}/tags/${t.slug}`}>{t.slug}</a>
              ))}
            </div>
          )}
        </div>
        <div class="toolbar">
          <a class="btn-icon" href={`${base}/api/v1/notes/${note.slug}/download-markdown`} title="Download Markdown" aria-label="Download Markdown">𝖬⬇</a>
          <button class="btn-icon" onClick={handleDownloadHtml} disabled={exporting}
            title={exporting ? 'Preparing HTML…' : 'Download HTML'} aria-label="Download HTML">HTML</button>
          <button class="btn-icon" title="Edit" aria-label="Edit" onClick={() => navigate(`/notes/${note.slug}/edit`)}>✎</button>
          <button class="danger btn-icon" onClick={handleDelete} disabled={deleting}
            title={deleting ? 'Deleting…' : 'Delete'} aria-label={deleting ? 'Deleting…' : 'Delete'}>❌︎</button>
        </div>
      </div>
      <div class="note-content" dangerouslySetInnerHTML={{ __html: renderedContent }} />
    </div>
  );
}
