import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { api, NotFoundError, type Note } from '../api/client.js';
import { navigate } from '../router.js';
import { base } from '../basepath.js';
import { showToast } from '../util/toast.js';
import { renderNote } from '../util/markdown.js';
import { renderMermaidBlocks } from '../util/mermaid.js';
import { useSlowLoading } from '../util/loading.js';
import { titleFromSlug } from '../util/title.js';
import { NoteActions } from '../components/NoteActions.js';
import { NoteEditor } from './NoteEditor.js';

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
  // Delayed mirror of `loading` for the visible indicator; see util/loading.ts.
  const slowLoading = useSlowLoading(loading);
  // Bumped after a not-found note is created so this view re-fetches and shows
  // the new note even though the URL (slug) is unchanged.
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [slug, reloadKey]);

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

  // Render any ```mermaid diagrams once the sanitized HTML is in the DOM.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    void renderMermaidBlocks(el);
  }, [renderedContent]);

  // Quick loads stay blank rather than flash the indicator; it appears only if
  // the fetch outlasts the delay.
  if (loading) return slowLoading ? <p class="muted">Loading…</p> : null;

  if (notFound) {
    // The note doesn't exist yet: open the new-note editor pre-filled with the
    // requested slug and a title suggested from it. On save, refresh the sidebar
    // and re-fetch here (the URL stays the same) so the created note is shown.
    return (
      <NoteEditor
        initialSlug={slug}
        initialTitle={titleFromSlug(slug)}
        onSave={() => { onDelete?.(); setReloadKey(k => k + 1); }}
      />
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
        <NoteActions
          slug={note.slug}
          title={note.title}
          onSplit={onDelete}
          onDeleted={() => { onDelete?.(); navigate('/'); }}
        />
      </div>
      <div class="note-content" ref={contentRef} dangerouslySetInnerHTML={{ __html: renderedContent }} />
      {note.incoming_links.length > 0 && (
        <section class="note-backlinks">
          <h2>Linked from</h2>
          <ul>
            {note.incoming_links.map(l => (
              <li key={l.slug}><a class="link" href={`${base}/notes/${l.slug}`}>{l.title}</a></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
