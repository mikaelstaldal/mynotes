import { useState, useEffect, useRef } from 'preact/hooks';
import {
  EditorView, keymap,
  defaultKeymap, history, historyKeymap,
  syntaxHighlighting, defaultHighlightStyle,
  markdown, EditorSelection,
} from 'codemirror';
import { api, NotFoundError, type CreateNoteRequest, type UpdateNoteRequest } from '../api/client.js';
import { navigate, setNavigationGuard } from '../router.js';
import { showToast } from '../util/toast.js';
import { renderNote, sanitizeSVGOrMathML } from '../util/markdown.js';
import { titleFromContent } from '../util/title.js';
import { slugFromTitle } from '../util/slug.js';
import { LinkPicker } from '../components/LinkPicker.js';

function escapeLinkText(s: string): string {
  return s.replace(/[\\[\]]/g, '\\$&');
}

type Layout = 'split' | 'editor' | 'preview';

interface Props {
  slug?: string;
  onSave?: () => void;
}

export function NoteEditor({ slug, onSave }: Props) {
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
  const imageInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const titleTouchedRef = useRef(false);    // true once user manually edits title
  // Snapshot of (title, content, slug) at last successful save or load — dirty baseline.
  const snapshotRef = useRef<{ title: string; content: string; slug: string | undefined }>({
    title: '', content: '', slug: undefined,
  });
  // Synchronous mirror of `dirty` state for the navigation guard closure.
  const dirtyRef = useRef(false);
  const originalSlugRef = useRef('');       // slug at load time (edit mode)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Register a navigation guard while this form is mounted so in-app link clicks
  // and the Cancel button ask for confirmation when there are unsaved changes.
  useEffect(() => {
    setNavigationGuard(() => {
      if (!dirtyRef.current) return true;
      return confirm('You have unsaved changes. Leave anyway?');
    });
    return () => setNavigationGuard(null);
  }, []);

  // Prevent browser refresh/tab-close when dirty.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Kept current every render so the CM updateListener never captures stale state.
  const handleDocChangeRef = useRef<(doc: string) => void>(() => {});
  handleDocChangeRef.current = (doc: string) => {
    // Resolve the title that will be in effect after this change (auto-sync or manual).
    let currentTitle = title;
    if (!titleTouchedRef.current) {
      const extracted = titleFromContent(doc);
      if (extracted !== null) {
        setTitle(extracted);
        currentTitle = extracted;
      }
    }
    const currentSlug = editing ? slugField : (slugOverrideActive ? slugOverride : undefined);
    const snap = snapshotRef.current;
    const d = currentTitle !== snap.title || doc !== snap.content || currentSlug !== snap.slug;
    setDirty(d);
    dirtyRef.current = d;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setPreviewHtml(renderNote(doc)), 300);
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
        snapshotRef.current = { title: note.title, content: note.content, slug: note.slug };
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
      doc: snapshotRef.current.content,
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
        snapshotRef.current = { title, content, slug: note.slug };
        dirtyRef.current = false;
        setDirty(false);
        onSave?.();
        navigate(`/notes/${note.slug}`);
      } else {
        const body: CreateNoteRequest = { title, content };
        if (slugOverrideActive && slugOverride) body.slug = slugOverride;
        const note = await api.notes.create(body);
        dirtyRef.current = false;
        setDirty(false);
        onSave?.();
        navigate(`/notes/${note.slug}`);
      }
    } catch (e) {
      if (e instanceof NotFoundError) {
        showToast('This note no longer exists');
        dirtyRef.current = false;
        setDirty(false);
        navigate('/');
      } else {
        showToast((e as Error).message);
      }
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

  function insertWrap(marker: string) {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    if (selected) {
      const insert = `${marker}${selected}${marker}`;
      view.dispatch({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + insert.length),
      });
    } else {
      const insert = `${marker}${marker}`;
      view.dispatch({
        changes: { from, insert },
        selection: EditorSelection.cursor(from + marker.length),
      });
    }
    view.focus();
  }

  function insertLinePrefix(prefix: string) {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc;
    const startLine = doc.lineAt(from);
    const endLine = doc.lineAt(to);
    const changes: { from: number; insert: string }[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
      changes.push({ from: doc.line(i).from, insert: prefix });
    }
    view.dispatch({ changes });
    view.focus();
  }

  function insertNumberedList() {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc;
    const startLine = doc.lineAt(from);
    const endLine = doc.lineAt(to);
    const changes: { from: number; insert: string }[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
      changes.push({ from: doc.line(i).from, insert: `${i - startLine.number + 1}. ` });
    }
    view.dispatch({ changes });
    view.focus();
  }

  function handleFileEmbed(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024) {
      showToast('File too large (max 4 KiB)');
      input.value = '';
      return;
    }
    const isSvg = file.type === 'image/svg+xml' || file.name.endsWith('.svg');
    const isMathML = file.type === 'application/mathml+xml'
      || file.name.endsWith('.mml') || file.name.endsWith('.mathml');
    const reader = new FileReader();
    if (isSvg || isMathML) {
      reader.onload = () => {
        const clean = sanitizeSVGOrMathML(reader.result as string);
        if (!clean) { showToast('File contains no allowed content'); return; }
        const view = viewRef.current;
        if (!view) return;
        const { from } = view.state.selection.main;
        view.dispatch({
          changes: { from, insert: clean },
          selection: EditorSelection.cursor(from + clean.length),
        });
        view.focus();
      };
      reader.readAsText(file);
    } else {
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const view = viewRef.current;
        if (!view) return;
        const { from } = view.state.selection.main;
        const altText = file.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
        const insert = `![${altText}](${dataUrl})`;
        view.dispatch({
          changes: { from, insert },
          selection: EditorSelection.cursor(from + insert.length),
        });
        view.focus();
      };
      reader.readAsDataURL(file);
    }
    input.value = '';
  }

  function insertExternalLink() {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    if (selected) {
      const insert = `[${selected}](https://)`;
      const urlStart = from + selected.length + 3;
      view.dispatch({
        changes: { from, to, insert },
        selection: EditorSelection.range(urlStart, urlStart + 8),
      });
    } else {
      const insert = `[](https://)`;
      view.dispatch({
        changes: { from, insert },
        selection: EditorSelection.cursor(from + 1),
      });
    }
    view.focus();
  }

  if (loading) return <p class="muted">Loading…</p>;

  const slugPreviewVal = slugFromTitle(title);
  const slugChanged = editing && slugField !== originalSlugRef.current;

  return (
    <form class="editor-page" onSubmit={handleSubmit}>
      <div class="editor-toolbar">
        <div class="layout-btns">
          <button type="button" class={layout === 'editor' ? 'active btn-icon' : 'btn-icon'} title="Editor" aria-label="Editor" onClick={() => setLayout('editor')}>✎</button>
          <button type="button" class={layout === 'split' ? 'active btn-icon' : 'btn-icon'} title="Split" aria-label="Split" onClick={() => setLayout('split')}>⊞</button>
          <button type="button" class={layout === 'preview' ? 'active btn-icon' : 'btn-icon'} title="Preview" aria-label="Preview" onClick={() => setLayout('preview')}>◉</button>
        </div>
        {dirty && <span class="dirty-dot" title="Unsaved changes">●</span>}
        <span class="toolbar-spacer" />
        <button type="button" class="btn-icon" title="Cancel" aria-label="Cancel" onClick={() => navigate(editing ? `/notes/${slug}` : '/')}>✕</button>
        <button type="submit" class="primary btn-icon" disabled={saving}
          title={saving ? 'Saving…' : 'Save'} aria-label={saving ? 'Saving…' : 'Save'}>✓</button>
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
              const v = (e.target as HTMLInputElement).value;
              titleTouchedRef.current = true;
              setTitle(v);
              const c = viewRef.current?.state.doc.toString() ?? '';
              const s = editing ? slugField : (slugOverrideActive ? slugOverride : undefined);
              const d = v !== snapshotRef.current.title || c !== snapshotRef.current.content || s !== snapshotRef.current.slug;
              setDirty(d); dirtyRef.current = d;
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
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setSlugField(v);
                const c = viewRef.current?.state.doc.toString() ?? '';
                const d = title !== snapshotRef.current.title || c !== snapshotRef.current.content || v !== snapshotRef.current.slug;
                setDirty(d); dirtyRef.current = d;
              }}
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
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  setSlugOverride(v);
                  const c = viewRef.current?.state.doc.toString() ?? '';
                  const d = title !== snapshotRef.current.title || c !== snapshotRef.current.content || v !== snapshotRef.current.slug;
                  setDirty(d); dirtyRef.current = d;
                }}
              />
            ) : (
              <>
                <span class="slug-preview">{slugPreviewVal || 'note'}</span>
                <button
                  type="button"
                  class="link"
                  onClick={() => {
                    setSlugOverride(slugPreviewVal);
                    setSlugOverrideActive(true);
                    const c = viewRef.current?.state.doc.toString() ?? '';
                    const d = title !== snapshotRef.current.title || c !== snapshotRef.current.content || slugPreviewVal !== snapshotRef.current.slug;
                    setDirty(d); dirtyRef.current = d;
                  }}
                >Override</button>
              </>
            )}
          </div>
        )}
      </div>

      {layout !== 'preview' && (
        <div class="format-toolbar">
          <button type="button" class="btn-icon fmt-bold" title="Bold" aria-label="Bold" onClick={() => insertWrap('**')}>B</button>
          <button type="button" class="btn-icon fmt-italic" title="Italic" aria-label="Italic" onClick={() => insertWrap('*')}>I</button>
          <button type="button" class="btn-icon fmt-code" title="Code" aria-label="Code" onClick={() => insertWrap('`')}>`</button>
          <span class="fmt-sep" role="separator" />
          <button type="button" class="btn-icon" title="Numbered list" aria-label="Numbered list" onClick={insertNumberedList}>1.</button>
          <button type="button" class="btn-icon" title="Bullet list" aria-label="Bullet list" onClick={() => insertLinePrefix('- ')}>•</button>
          <span class="fmt-sep" role="separator" />
          <button type="button" class="btn-icon" title="External link" aria-label="External link" onClick={insertExternalLink}>↗</button>
          <button type="button" class="btn-icon" title="Internal link" aria-label="Internal link" onClick={() => setPickerOpen(true)}>⛓</button>
          <span class="fmt-sep" role="separator" />
          <button type="button" class="btn-icon" title="Embed image / SVG / MathML" aria-label="Embed image, SVG, or MathML" onClick={() => imageInputRef.current?.click()}>⬆</button>
          <input ref={imageInputRef} type="file" accept="image/gif,image/png,image/jpeg,image/webp,image/svg+xml,application/mathml+xml,.mml,.mathml" style={{ display: 'none' }} onChange={handleFileEmbed} />
        </div>
      )}

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
