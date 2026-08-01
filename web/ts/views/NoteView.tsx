import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { api, NotFoundError, type Note } from '../api/client.js';
import { navigate, currentPath } from '../router.js';
import { base } from '../basepath.js';
import { showToast } from '../util/toast.js';
import { renderNote } from '../util/markdown.js';
import { taskToggleAt } from '../util/tasks.js';
import { renderMermaidBlocks } from '../util/mermaid.js';
import { onThemeChange } from '../util/theme.js';
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

  // Re-fetch the note in place, without the loading state the effect above
  // enters. Used after publishing, where the only thing that changed is
  // published_at and blanking the view would be a pointless flash.
  async function refreshNote() {
    try {
      setNote(await api.notes.get(slug));
    } catch {
      // The toolbar has already reported the outcome of the action itself; a
      // stale published_at until the next navigation is not worth a second toast.
    }
  }

  useEffect(() => {
    if (!note) return;
    const prev = document.title;
    document.title = note.title;
    return () => { document.title = prev; };
  }, [note]);

  const renderedContent = useMemo(() => {
    if (!note) return '';
    // Clickable task-list checkboxes: see handleContentClick.
    return renderNote(note.content, { interactiveTasks: true });
  }, [note]);

  // Render any ```mermaid diagrams once the sanitized HTML is in the DOM.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    void renderMermaidBlocks(el);
  }, [renderedContent]);

  // Mermaid bakes theme colours into its SVG output, so a live light/dark toggle
  // can't re-colour an already-rendered diagram via CSS. When the theme changes
  // and this note has a diagram, restore the source blocks and re-render them.
  // Notes without a diagram re-theme instantly through CSS variables, so they're
  // left untouched (preserving e.g. open/closed foldable callouts).
  useEffect(() => onThemeChange(() => {
    const el = contentRef.current;
    if (!el || !el.querySelector('.mermaid-diagram, code.language-mermaid')) return;
    el.innerHTML = renderedContent;
    void renderMermaidBlocks(el);
  }), [renderedContent]);

  // While a note is shown, stop main from scrolling as a whole (like the editor
  // toggles editor-main) so the header stays fixed and only the content scrolls.
  // Gated on a loaded note so the loading/not-found branches keep main scrolling.
  const showNote = !!note;
  useEffect(() => {
    if (!showNote) return;
    const main = document.querySelector('main');
    main?.classList.add('note-view-main');
    return () => main?.classList.remove('note-view-main');
  }, [showNote]);

  // The task-list checkbox is the one interactive thing in the read view:
  // clicking it opens the note in the editor with that item flipped — and
  // nothing saved, so the choice between keeping and discarding the change stays
  // with the user. The checkbox here is left as it is (preventDefault): the copy
  // in the editor's preview is the one that moves, once the editor has the note.
  // The edit is resolved here first, against the content this view rendered, so
  // a click that could not produce one does not cost a trip to the editor.
  function handleContentClick(e: MouseEvent) {
    const box = (e.target as Element | null)?.closest?.('input.task-list-item-checkbox[data-task-line]');
    if (!box) return;
    e.preventDefault();
    const line = Number(box.getAttribute('data-task-line'));
    const checked = (box as HTMLInputElement).defaultChecked;
    if (!note || !taskToggleAt(note.content, line, checked)) return;
    navigate(`/notes/${slug}/edit`, {
      returnTo: currentPath(), toggleTaskLine: line, toggleTaskChecked: checked,
    });
  }

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
          publishedAt={note.published_at}
          onSplit={onDelete}
          onDeleted={() => { onDelete?.(); navigate('/'); }}
          onPublishChange={refreshNote}
        />
      </div>
      <div class="note-view-scroll">
        <div class="note-content" ref={contentRef} onClick={handleContentClick}
          dangerouslySetInnerHTML={{ __html: renderedContent }} />
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
    </div>
  );
}
