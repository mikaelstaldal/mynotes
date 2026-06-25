import { useState, useEffect, useRef } from 'preact/hooks';
import {
  EditorView, keymap,
  defaultKeymap, history, historyKeymap,
  syntaxHighlighting, defaultHighlightStyle,
  markdown, EditorSelection,
} from 'codemirror';
import { api, NotFoundError, type CreateNoteRequest, type UpdateNoteRequest } from '../api/client.js';
import { navigate } from '../router.js';
import { showToast } from '../util/toast.js';
import { renderNote } from '../util/markdown.js';
import { titleFromContent } from '../util/title.js';
import { slugFromTitle } from '../util/slug.js';
import { LinkPicker } from '../components/LinkPicker.js';

function escapeLinkText(s: string): string {
  return s.replace(/[\\[\]]/g, '\\$&');
}

type Layout = 'split' | 'editor' | 'preview';

interface Props {
  slug?: string;
}

export function ItemForm({ slug }: Props) {
  const editing = slug !== undefined;

  const [title, setTitle] = useState('');
  const [slugField, setSlugField] = useState('');         // edit: current slug value
  const [slugOverride, setSlugOverride] = useState('');   // new: explicit slug when overriding
  const [slugOverrideActive, setSlugOverrideActive] = useState(false);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [layout, setLayout] = useState<Layout>('split');
  const [previewHtml, setPreviewHtml] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const titleTouchedRef = useRef(false);    // true once user manually edits title
  const initialContentRef = useRef('');     // content at last save/load; dirty baseline
  const originalSlugRef = useRef('');       // slug at load time (edit mode)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Kept current every render so the CM updateListener never captures stale state.
  const handleDocChangeRef = useRef<(doc: string) => void>(() => {});
  handleDocChangeRef.current = (doc: string) => {
    setDirty(doc !== initialContentRef.current);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setPreviewHtml(renderNote(doc)), 300);
    if (!titleTouchedRef.current) {
      const extracted = titleFromContent(doc);
      if (extracted !== null) setTitle(extracted);
    }
  };

  // Load note for edit mode.
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const note = await api.notes.get(slug);
        if (cancelled) return;
        setTitle(note.title);
        setSlugField(note.slug);
        originalSlugRef.current = note.slug;
        initialContentRef.current = note.content;
        titleTouchedRef.current = true; // suppress auto-sync in edit mode
        setPreviewHtml(renderNote(note.content));
      } catch (e) {
        if (cancelled) return;
        if (e instanceof NotFoundError) { showToast('Note not found'); navigate('/'); }
        else showToast(`Failed to load: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [slug, editing]);

  // Create CodeMirror editor once content is available.
  // For /new: runs on mount (loading is already false).
  // For edit: runs after loading becomes false and the editor container appears in DOM.
  useEffect(() => {
    if (!editorContainerRef.current) return;

    const view = new EditorView({
      doc: initialContentRef.current,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        syntaxHighlighting(defaultHighlightStyle),
        markdown(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handleDocChangeRef.current(update.state.doc.toString());
        }),
      ],
      parent: editorContainerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    };
  }, [loading]); // re-runs when loading flips to false (editor container is in DOM by then)

  // When switching away from preview, ask CM to remeasure (display:none clears its size).
  const prevLayoutRef = useRef(layout);
  useEffect(() => {
    if (prevLayoutRef.current === 'preview' && layout !== 'preview') {
      const t = setTimeout(() => viewRef.current?.requestMeasure(), 0);
      return () => clearTimeout(t);
    }
    prevLayoutRef.current = layout;
  }, [layout]);

  // Expand main to full width while the editor is mounted.
  useEffect(() => {
    const main = document.querySelector('main');
    main?.classList.add('editor-main');
    return () => main?.classList.remove('editor-main');
  }, []);

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    const content = viewRef.current?.state.doc.toString() ?? '';
    setSaving(true);
    try {
      if (editing) {
        const body: UpdateNoteRequest = { title, content };
        if (slugField !== originalSlugRef.current) body.slug = slugField;
        const note = await api.notes.update(slug, body);
        initialContentRef.current = content;
        setDirty(false);
        navigate(`/notes/${note.slug}`);
      } else {
        const body: CreateNoteRequest = { title, content };
        if (slugOverrideActive && slugOverride) body.slug = slugOverride;
        const note = await api.notes.create(body);
        navigate(`/notes/${note.slug}`);
      }
    } catch (e) {
      showToast(`Failed to save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function insertLink(noteSlug: string, noteTitle: string) {
    setPickerOpen(false);
    const view = viewRef.current;
    if (!view) return;
    const { from } = view.state.selection.main;
    const text = `[${escapeLinkText(noteTitle)}](/notes/${noteSlug})`;
    view.dispatch({
      changes: { from, insert: text },
      selection: EditorSelection.cursor(from + text.length),
    });
    view.focus();
  }

  if (loading) return <p class="muted">Loading…</p>;

  const slugPreviewVal = slugFromTitle(title);
  const slugChanged = editing && slugField !== originalSlugRef.current;

  return (
    <form class="editor-page" onSubmit={handleSubmit}>
      <div class="editor-toolbar">
        <div class="layout-btns">
          <button type="button" class={layout === 'editor' ? 'active' : ''} onClick={() => setLayout('editor')}>Editor</button>
          <button type="button" class={layout === 'split' ? 'active' : ''} onClick={() => setLayout('split')}>Split</button>
          <button type="button" class={layout === 'preview' ? 'active' : ''} onClick={() => setLayout('preview')}>Preview</button>
        </div>
        {dirty && <span class="dirty-dot" title="Unsaved changes">●</span>}
        <span class="toolbar-spacer" />
        <button type="button" onClick={() => setPickerOpen(true)}>Link</button>
        <button type="button" onClick={() => navigate(editing ? `/notes/${slug}` : '/')}>Cancel</button>
        <button type="submit" class="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      <div class="editor-meta">
        <label class="meta-title">
          Title
          <input
            type="text"
            value={title}
            required
            maxLength={200}
            onInput={(e) => {
              titleTouchedRef.current = true;
              setTitle((e.target as HTMLInputElement).value);
            }}
          />
        </label>

        {editing ? (
          <label class="meta-slug">
            Slug
            <input
              type="text"
              value={slugField}
              maxLength={100}
              pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
              onInput={(e) => setSlugField((e.target as HTMLInputElement).value)}
            />
            {slugChanged && <span class="slug-warning">URL will change</span>}
          </label>
        ) : (
          <div class="meta-slug">
            <span class="meta-label-text">Slug</span>
            {slugOverrideActive ? (
              <input
                type="text"
                value={slugOverride}
                maxLength={100}
                pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
                placeholder={slugPreviewVal}
                onInput={(e) => setSlugOverride((e.target as HTMLInputElement).value)}
              />
            ) : (
              <>
                <span class="slug-preview">{slugPreviewVal || 'note'}</span>
                <button
                  type="button"
                  class="link"
                  onClick={() => { setSlugOverride(slugPreviewVal); setSlugOverrideActive(true); }}
                >Override</button>
              </>
            )}
          </div>
        )}
      </div>

      <div class={`editor-layout editor-layout--${layout}`}>
        <div class="editor-pane" ref={editorContainerRef} />
        <div class="preview-pane note-content" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      </div>

      {pickerOpen && (
        <LinkPicker
          currentSlug={slug}
          onSelect={insertLink}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </form>
  );
}
