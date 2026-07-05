import { useState, useEffect, useRef } from 'preact/hooks';
import {
  EditorView, keymap,
  defaultKeymap, history, historyKeymap,
  syntaxHighlighting, defaultHighlightStyle,
  markdown, EditorSelection,
  ViewPlugin, Decoration, WidgetType,
  type DecorationSet, type ViewUpdate,
} from 'codemirror';
import { api, NotFoundError, PreconditionFailedError, type CreateNoteRequest, type UpdateNoteRequest, type Tag } from '../api/client.js';
import { base } from '../basepath.js';
import { navigate, setNavigationGuard } from '../router.js';
import { showToast } from '../util/toast.js';
import { renderNote, sanitizeSVGOrMathML } from '../util/markdown.js';
import { titleFromContent } from '../util/title.js';
import { slugFromTitle } from '../util/slug.js';
import { LinkPicker } from '../components/LinkPicker.js';
import { TagLinkPicker } from '../components/TagLinkPicker.js';
import { TagPicker } from '../components/TagPicker.js';

const DATA_URL_RE = /data:([^;,\s]+);base64,[A-Za-z0-9+/]+=*/g;

class DataUrlWidget extends WidgetType {
  constructor(readonly mimeType: string) { super(); }
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-data-url-collapsed';
    s.textContent = '…';
    s.title = this.mimeType;
    return s;
  }
  eq(other: DataUrlWidget) { return other.mimeType === this.mimeType; }
}

function buildDataUrlDecos(view: EditorView): DecorationSet {
  const sel = view.state.selection;
  const text = view.state.doc.toString();
  const deco: ReturnType<ReturnType<typeof Decoration.replace>['range']>[] = [];
  DATA_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATA_URL_RE.exec(text)) !== null) {
    const dataStart = m.index + m[0].indexOf(';base64,') + 8;
    const dataEnd = m.index + m[0].length;
    const overlaps = sel.ranges.some(r => r.from <= dataEnd && r.to >= dataStart);
    if (!overlaps) {
      deco.push(Decoration.replace({ widget: new DataUrlWidget(m[1]) }).range(dataStart, dataEnd));
    }
  }
  return Decoration.set(deco);
}

const dataUrlCollapse = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDataUrlDecos(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = buildDataUrlDecos(u.view);
    }
  },
  { decorations: v => v.decorations },
);

function sortedSlugs(tags: Tag[]): string[] {
  return tags.map(t => t.slug).sort();
}

function sameSlugs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

type Layout = 'split' | 'editor' | 'preview';

interface Props {
  slug?: string;
  onSave?: () => void;
}

export function NoteEditor({ slug, onSave }: Props) {
  const editing = slug !== undefined;

  const [title, setTitle] = useState('');
  const [slugOverride, setSlugOverride] = useState('');   // new: explicit slug when overriding
  const [slugOverrideActive, setSlugOverrideActive] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [layout, setLayout] = useState<Layout>('split');
  const [previewHtml, setPreviewHtml] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tagLinkPickerOpen, setTagLinkPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const titleTouchedRef = useRef(false);    // true once user manually edits title
  // Snapshot of (title, content, slug, tags) at last successful save or load —
  // dirty baseline. tags is a sorted slug array for order-independent diffing.
  const snapshotRef = useRef<{ title: string; content: string; slug: string | undefined; tags: string[] }>({
    title: '', content: '', slug: undefined, tags: [],
  });
  const versionRef = useRef<number | undefined>(undefined);
  // Synchronous mirror of `dirty` state for the navigation guard closure.
  const dirtyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Diffs (title, content, slug, tags) against the last-saved/loaded snapshot
  // and updates both the dirty state and its synchronous ref mirror.
  function applyDirty(nextTitle: string, nextContent: string, nextSlug: string | undefined, nextTags: Tag[]) {
    const snap = snapshotRef.current;
    const d = nextTitle !== snap.title || nextContent !== snap.content || nextSlug !== snap.slug
      || !sameSlugs(sortedSlugs(nextTags), snap.tags);
    setDirty(d);
    dirtyRef.current = d;
  }

  function handleTagsChange(next: Tag[]) {
    setTags(next);
    const content = viewRef.current?.state.doc.toString() ?? '';
    const currentSlug = editing ? snapshotRef.current.slug : (slugOverrideActive ? slugOverride : undefined);
    applyDirty(title, content, currentSlug, next);
  }

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
    const currentSlug = editing ? snapshotRef.current.slug : (slugOverrideActive ? slugOverride : undefined);
    applyDirty(currentTitle, doc, currentSlug, tags);
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
        setTags(note.tags);
        versionRef.current = note.version;
        snapshotRef.current = { title: note.title, content: note.content, slug: note.slug, tags: sortedSlugs(note.tags) };
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
        dataUrlCollapse,
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
      const tagSlugs = tags.map(t => t.slug);
      if (editing) {
        const body: UpdateNoteRequest = { title, content, tags: tagSlugs };
        const ifMatch = versionRef.current !== undefined
          ? `"${versionRef.current}"`
          : undefined;
        const note = await api.notes.update(slug, body, ifMatch);
        versionRef.current = note.version;
        snapshotRef.current = { title, content, slug: note.slug, tags: sortedSlugs(tags) };
        dirtyRef.current = false;
        setDirty(false);
        onSave?.();
        navigate(`/notes/${note.slug}`);
      } else {
        const body: CreateNoteRequest = { title, content, tags: tagSlugs };
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
      } else if (e instanceof PreconditionFailedError) {
        showToast('Note was modified elsewhere — please reload before saving');
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
    // Add an alias ([[slug|Title]]) only when the title adds information over the
    // default slug text and is representable in the syntax (the label may not
    // contain ']' or a newline).
    const useAlias = noteTitle !== noteSlug && !/[\]\n]/.test(noteTitle);
    const text = useAlias ? `[[${noteSlug}|${noteTitle}]]` : `[[${noteSlug}]]`;
    view.dispatch({
      changes: { from, insert: text },
      selection: EditorSelection.cursor(from + text.length),
    });
    view.focus();
  }

  function insertTagLink(tagSlug: string, tagName: string) {
    setTagLinkPickerOpen(false);
    const view = viewRef.current;
    if (!view) return;
    const { from } = view.state.selection.main;
    // Add an alias ([[#slug|Name]]) only when the display name adds information
    // over the default "#slug" text and is representable in the syntax (the
    // label may not contain ']' or a newline).
    const useAlias = tagName !== tagSlug && !/[\]\n]/.test(tagName);
    const text = useAlias ? `[[#${tagSlug}|${tagName}]]` : `[[#${tagSlug}]]`;
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

  async function handleFileEmbed(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    const isSvg = file.type === 'image/svg+xml' || file.name.endsWith('.svg');
    const isMathML = file.type === 'application/mathml+xml'
      || file.name.endsWith('.mml') || file.name.endsWith('.mathml');
    if (isSvg || isMathML) {
      const reader = new FileReader();
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
      setUploading(true);
      try {
        const artifact = await api.artifacts.create(file);
        const view = viewRef.current;
        if (!view) return;
        const { from } = view.state.selection.main;
        const altText = file.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
        const insert = `![${altText}](${base}/api/v1/artifacts/${artifact.sha256})`;
        view.dispatch({
          changes: { from, insert },
          selection: EditorSelection.cursor(from + insert.length),
        });
        view.focus();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    }
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
              const s = editing ? snapshotRef.current.slug : (slugOverrideActive ? slugOverride : undefined);
              applyDirty(v, c, s, tags);
            }}
          />
        </label>

        {!editing && (
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
                  applyDirty(title, c, v, tags);
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
                    applyDirty(title, c, slugPreviewVal, tags);
                  }}
                >Override</button>
              </>
            )}
          </div>
        )}

        <div class="meta-tags">
          <span class="meta-label-text">Tags</span>
          <TagPicker selected={tags} onChange={handleTagsChange} />
        </div>
      </div>

      {layout !== 'preview' && (
        <div class="format-toolbar">
          <button type="button" class="btn-icon" title="Bold" aria-label="Bold" onClick={() => insertWrap('**')}>
            <svg viewBox="0 0 18 18">
              <path class="fmt-stroke" d="M5,4H9.5A2.5,2.5,0,0,1,12,6.5v0A2.5,2.5,0,0,1,9.5,9H5A0,0,0,0,1,5,9V4A0,0,0,0,1,5,4Z"></path>
              <path class="fmt-stroke" d="M5,9h5.5A2.5,2.5,0,0,1,13,11.5v0A2.5,2.5,0,0,1,10.5,14H5a0,0,0,0,1,0,0V9A0,0,0,0,1,5,9Z"></path>
            </svg>
          </button>
          <button type="button" class="btn-icon" title="Italic" aria-label="Italic" onClick={() => insertWrap('*')}>
            <svg viewBox="0 0 18 18">
              <line class="fmt-stroke" x1="7" x2="13" y1="4" y2="4"></line>
              <line class="fmt-stroke" x1="5" x2="11" y1="14" y2="14"></line>
              <line class="fmt-stroke" x1="8" x2="10" y1="14" y2="4"></line>
            </svg>
          </button>
          <button type="button" class="btn-icon" title="Code" aria-label="Code" onClick={() => insertWrap('`')}>
            <svg viewBox="0 0 18 18">
              <polyline class="fmt-even fmt-stroke" points="5 7 3 9 5 11"></polyline>
              <polyline class="fmt-even fmt-stroke" points="13 7 15 9 13 11"></polyline>
              <line class="fmt-stroke" x1="10" x2="8" y1="5" y2="13"></line>
            </svg>
          </button>
          <span class="fmt-sep" role="separator" />
          <button type="button" class="btn-icon" title="Numbered list" aria-label="Numbered list" onClick={insertNumberedList}>
            <svg viewBox="0 0 18 18">
              <line class="fmt-stroke" x1="7" x2="15" y1="4" y2="4"/>
              <line class="fmt-stroke" x1="7" x2="15" y1="9" y2="9"/>
              <line class="fmt-stroke" x1="7" x2="15" y1="14" y2="14"/>
              <line class="fmt-stroke fmt-thin" x1="2.5" x2="4.5" y1="5.5" y2="5.5"/>
              <path class="fmt-fill" d="M3.5,6A0.5,0.5,0,0,1,3,5.5V3.085l-0.276.138A0.5,0.5,0,0,1,2.053,3c-0.124-.247-0.023-0.324.224-0.447l1-.5A0.5,0.5,0,0,1,4,2.5v3A0.5,0.5,0,0,1,3.5,6Z"/>
              <path class="fmt-stroke fmt-thin" d="M4.5,10.5h-2c0-.234,1.85-1.076,1.85-2.234A0.959,0.959,0,0,0,2.5,8.156"/>
              <path class="fmt-stroke fmt-thin" d="M2.5,14.846a0.959,0.959,0,0,0,1.85-.109A0.7,0.7,0,0,0,3.75,14a0.688,0.688,0,0,0,.6-0.736,0.959,0.959,0,0,0-1.85-.109"/>
            </svg>
          </button>
          <button type="button" class="btn-icon" title="Bullet list" aria-label="Bullet list" onClick={() => insertLinePrefix('- ')}>
            <svg viewBox="0 0 18 18">
              <line class="fmt-stroke" x1="6" x2="15" y1="4" y2="4"/>
              <line class="fmt-stroke" x1="6" x2="15" y1="9" y2="9"/>
              <line class="fmt-stroke" x1="6" x2="15" y1="14" y2="14"/>
              <line class="fmt-stroke" x1="3" x2="3" y1="4" y2="4"/>
              <line class="fmt-stroke" x1="3" x2="3" y1="9" y2="9"/>
              <line class="fmt-stroke" x1="3" x2="3" y1="14" y2="14"/>
            </svg>
          </button>
          <span class="fmt-sep" role="separator" />
          <button type="button" class="btn-icon" title="Internal link" aria-label="Internal link" onClick={() => setPickerOpen(true)}>
            <svg viewBox="0 0 18 18">
              <line class="fmt-stroke" x1="7" x2="11" y1="7" y2="11"/>
              <path class="fmt-even fmt-stroke" d="M8.9,4.577a3.476,3.476,0,0,1,.36,4.679A3.476,3.476,0,0,1,4.577,8.9C3.185,7.5,2.035,6.4,4.217,4.217S7.5,3.185,8.9,4.577Z"/>
              <path class="fmt-even fmt-stroke" d="M13.423,9.1a3.476,3.476,0,0,0-4.679-.36,3.476,3.476,0,0,0,.36,4.679c1.392,1.392,2.5,2.542,4.679.36S14.815,10.5,13.423,9.1Z"/>
            </svg>
          </button>
          <button type="button" class="btn-icon" title="Tag link" aria-label="Tag link" onClick={() => setTagLinkPickerOpen(true)}>
            <svg viewBox="0 0 18 18">
              <path class="fmt-even fmt-stroke" d="M8.5,3H4A1,1,0,0,0,3,4V8.5a1,1,0,0,0,.293.707l6,6a1,1,0,0,0,1.414,0l4.5-4.5a1,1,0,0,0,0-1.414l-6-6A1,1,0,0,0,8.5,3Z"/>
              <circle class="fmt-fill" cx="6" cy="6" r="1"/>
            </svg>
          </button>
          <button type="button" class="btn-icon" title="External link" aria-label="External link" onClick={insertExternalLink}>
            <svg viewBox="0 0 18 18">
              <line class="fmt-stroke" x1="9" y1="9" x2="15" y2="3"/>
              <polyline class="fmt-stroke" points="11,3 15,3 15,7"/>
              <polyline class="fmt-stroke" points="9,5 4,5 4,14 13,14 13,9"/>
            </svg>
          </button>
          <span class="fmt-sep" role="separator" />
          <button type="button" class="btn-icon" title="Embed image / SVG / MathML" aria-label="Embed image, SVG, or MathML" disabled={uploading} onClick={() => imageInputRef.current?.click()}>
            {uploading ? '…' : (
              <svg viewBox="0 0 18 18">
                <rect class="fmt-stroke" height="10" width="12" x="3" y="4"></rect>
                <circle class="fmt-fill" cx="6" cy="7" r="1"></circle>
                <polyline class="fmt-even fmt-fill" points="5 12 5 11 7 9 8 10 11 7 13 9 13 12 5 12"></polyline>
              </svg>
            )}
          </button>
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

      {tagLinkPickerOpen && (
        <TagLinkPicker
          onSelect={insertTagLink}
          onClose={() => setTagLinkPickerOpen(false)}
        />
      )}
    </form>
  );
}
