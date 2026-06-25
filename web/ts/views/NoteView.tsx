import { useState, useEffect, useMemo } from 'preact/hooks';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { api, NotFoundError, type Note } from '../api/client.js';
import { navigate } from '../router.js';
import { showToast } from '../util/toast.js';

const md = new MarkdownIt({ html: true });

interface Props {
  slug: string;
}

export function NoteView({ slug }: Props) {
  const [note, setNote] = useState<Note | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

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

  const renderedContent = useMemo(() => {
    if (!note) return '';
    return DOMPurify.sanitize(md.render(note.content));
  }, [note]);

  if (loading) return <p class="muted">Loading…</p>;

  if (notFound) {
    return (
      <div class="note-view">
        <p class="muted">Note not found.</p>
        <a href="/">Back to list</a>
      </div>
    );
  }

  if (!note) return null;

  return (
    <div class="note-view">
      <div class="toolbar">
        <a href="/">Back</a>
        <a href={`/api/v1/notes/${note.slug}/download`}>Download</a>
        <button class="primary" onClick={() => navigate(`/notes/${note.slug}/edit`)}>Edit</button>
      </div>
      <h2>{note.title}</h2>
      <div class="note-content" dangerouslySetInnerHTML={{ __html: renderedContent }} />
    </div>
  );
}
