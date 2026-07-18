import { useState, useEffect, useMemo } from 'preact/hooks';
import { api, NotFoundError, type Note } from '../api/client.js';
import { navigate } from '../router.js';
import { base } from '../basepath.js';
import { showToast } from '../util/toast.js';
import { renderNote } from '../util/markdown.js';
import { SplitDialog } from '../components/SplitDialog.js';

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
  const [splitting, setSplitting] = useState(false);
  const [showSplit, setShowSplit] = useState(false);

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

  // Print reuses the server-rendered Download HTML document (standalone, with
  // internal images inlined): it is loaded into an off-screen iframe whose
  // print dialog is then invoked, so the printout matches the exported file
  // rather than the surrounding app chrome.
  async function handlePrint() {
    if (!note) return;
    try {
      const html = await api.notes.exportHtml(note.slug);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.onload = () => {
        const win = iframe.contentWindow;
        if (!win) { iframe.remove(); return; }
        const cleanup = () => iframe.remove();
        win.addEventListener('afterprint', cleanup);
        win.focus();
        win.print();
        // Fallback removal for browsers that never fire afterprint.
        setTimeout(cleanup, 60000);
      };
      iframe.srcdoc = html;
      document.body.appendChild(iframe);
    } catch (e) {
      if (e instanceof NotFoundError) {
        showToast('Note not found');
      } else {
        showToast(`Failed to print: ${(e as Error).message}`);
      }
    }
  }

  // Split the note into several notes at its top-level Markdown headings. The
  // optional tag (chosen in the SplitDialog, undefined = none) is attached to
  // every new note. On success we navigate to the tag page when a tag was given
  // (it lists all the new notes), otherwise to the first created note. The
  // source note is left unchanged.
  async function doSplit(tag: string | undefined) {
    if (!note) return;
    setSplitting(true);
    try {
      const result = await api.notes.split(note.slug, tag);
      const count = result.notes.length;
      showToast(`Split into ${count} note${count === 1 ? '' : 's'}`);
      // Close the dialog explicitly: when no tag is chosen we navigate to
      // another /notes/{slug} route, which reuses this same NoteView instance
      // (only the slug prop changes), so the dialog would otherwise stay open.
      setShowSplit(false);
      if (tag) {
        navigate(`/tags/${tag}`);
      } else if (result.notes[0]) {
        navigate(`/notes/${result.notes[0].slug}`);
      } else {
        navigate('/');
      }
    } catch (e) {
      if (e instanceof NotFoundError) {
        showToast('Note not found');
      } else {
        showToast(`Failed to split: ${(e as Error).message}`);
      }
      setShowSplit(false);
    } finally {
      setSplitting(false);
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
          <a class="btn-icon" href={`${base}/api/v1/notes/${note.slug}/download-html`} title="Download HTML" aria-label="Download HTML">HTML</a>
          <button class="btn-icon" title="Print" aria-label="Print" onClick={handlePrint}>🖨</button>
          <button class="btn-icon" title="Split by headings" aria-label="Split by headings" onClick={() => setShowSplit(true)} disabled={splitting}>✂</button>
          <button class="btn-icon" title="Edit" aria-label="Edit" onClick={() => navigate(`/notes/${note.slug}/edit`)}>✎</button>
          <button class="danger btn-icon" onClick={handleDelete} disabled={deleting}
            title={deleting ? 'Deleting…' : 'Delete'} aria-label={deleting ? 'Deleting…' : 'Delete'}>❌︎</button>
        </div>
      </div>
      <div class="note-content" dangerouslySetInnerHTML={{ __html: renderedContent }} />
      {showSplit && (
        <SplitDialog busy={splitting} onClose={() => setShowSplit(false)} onSplit={doSplit} />
      )}
    </div>
  );
}
