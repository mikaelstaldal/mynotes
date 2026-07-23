import { render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { currentRoute, onRouteChange, navigate, tagsPath, type Route } from './router.js';
import { getConfig, saveConfig } from './util/config.js';
import { isValidSlug, slugFromTitle } from './util/slug.js';
import { showToast } from './util/toast.js';
import { api, type SortField, type SortOrder } from './api/client.js';
import { NoteList } from './views/NoteList.js';
import { NotesOverview } from './views/NotesOverview.js';
import { NoteEditor } from './views/NoteEditor.js';
import { NoteView } from './views/NoteView.js';
import { TagManager } from './views/TagManager.js';
import { NotesGraph } from './views/NotesGraph.js';
import { Toast } from './components/Toast.js';

type SidebarTab = 'notes' | 'tags' | 'graph';

function App() {
  const [route, setRoute] = useState<Route>(currentRoute());
  const [listKey, setListKey] = useState(0);
  const [sortField, setSortField] = useState<SortField>(() => getConfig().sortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => getConfig().sortOrder);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('notes');
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => onRouteChange(setRoute), []);

  // Apply the persisted theme to the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = getConfig().theme;
  }, []);

  const refreshList = useCallback(() => setListKey(k => k + 1), []);

  // Upload a Markdown or HTML file as a new note, then open it. Lives here (not
  // in NoteList) because the trigger buttons sit in the sidebar header.
  const handleUpload = useCallback(async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();

    if ([...text].length > 1_000_000) {
      showToast('File too large: must be at most 1,000,000 characters.');
      input.value = '';
      return;
    }

    const isHtml = /\.html?$/i.test(file.name) || file.type === 'text/html';
    try {
      const note = isHtml
        ? await api.notes.importHtml(text)
        : await api.notes.importMarkdown(text);
      refreshList();
      navigate(`/notes/${note.slug}`);
    } catch (err) {
      showToast(`Upload failed: ${(err as Error).message}`);
    }
    // Reset so the same file can be re-uploaded.
    input.value = '';
  }, [refreshList]);

  // From the tag-management tab, opening a tag filters the main-panel note list
  // by it. The sidebar stays on the tags tab so the tag list remains visible.
  const openTag = useCallback((slug: string) => {
    navigate(tagsPath([slug]));
  }, []);

  // Create a new, empty tag from the tags-tab header. The name is slugified the
  // same way tag creation elsewhere is, then refreshList() reloads the sidebar's
  // TagManager so the new tag appears.
  const handleNewTag = useCallback(async () => {
    const name = prompt('New tag name:');
    if (name === null) return;
    const trimmed = name.trim();
    const slug = slugFromTitle(trimmed);
    // slugFromTitle falls back to "note" when nothing usable survives (e.g.
    // "---"); reject such names rather than silently creating a "note" tag. The
    // fold here mirrors slugFromTitle's, so a genuine slug char must remain.
    const folded = trimmed.toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '');
    if (!/[a-z0-9]/.test(folded) || !isValidSlug(slug)) {
      showToast('Invalid tag name.');
      return;
    }
    try {
      await api.tags.create({ slug });
      refreshList();
    } catch (err) {
      showToast(`Failed to create tag: ${(err as Error).message}`);
    }
  }, [refreshList]);

  // Persist the sort choice so it survives reloads, and drive both the sidebar
  // list and the main-panel overview from the same state.
  const changeSort = useCallback((field: SortField, order: SortOrder) => {
    setSortField(field);
    setSortOrder(order);
    saveConfig({ ...getConfig(), sortField: field, sortOrder: order });
  }, []);

  // Navigating to a tag filter that names tags which don't exist yet (via a
  // /tags/<slug> URL or a tag link in a note) auto-creates each as an empty tag,
  // so they become real and show up in the sidebar's tag picker. Existing tags
  // are left untouched, and malformed slugs the backend would reject are ignored.
  const routeTagsKey = route.type === 'list' ? route.tags.join(',') : '';
  useEffect(() => {
    if (route.type !== 'list' || route.tags.length === 0) return;
    const wanted = route.tags.filter(isValidSlug);
    if (wanted.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { tags } = await api.tags.list();
        const existing = new Set(tags.map(t => t.slug));
        const missing = wanted.filter(t => !existing.has(t));
        if (cancelled || missing.length === 0) return;
        await Promise.all(missing.map(slug => api.tags.create({ slug })));
        if (cancelled) return;
        refreshList();
      } catch {
        // Best-effort: a failure here (e.g. a race that created a tag first, or
        // a transient error) just leaves the tag view empty, as it was before.
      }
    })();
    return () => { cancelled = true; };
    // routeTagsKey collapses the tags array to a stable string so a new array
    // identity on each render doesn't retrigger this effect.
  }, [routeTagsKey, refreshList]);

  const activeSlug = (route.type === 'view' || route.type === 'edit') ? route.slug : undefined;

  return (
    <>
      <div class="app-body">
        <aside class="sidebar">
          <div class="sidebar-header">
            <a class="brand sidebar-brand" href="/">MyNotes</a>
            <div class="sidebar-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={sidebarTab === 'notes'}
                class={`sidebar-tab${sidebarTab === 'notes' ? ' active' : ''}`}
                onClick={() => setSidebarTab('notes')}
              >Notes</button>
              <button
                role="tab"
                aria-selected={sidebarTab === 'tags'}
                class={`sidebar-tab${sidebarTab === 'tags' ? ' active' : ''}`}
                onClick={() => setSidebarTab('tags')}
              >Tags</button>
              <button
                role="tab"
                aria-selected={sidebarTab === 'graph'}
                class={`sidebar-tab${sidebarTab === 'graph' ? ' active' : ''}`}
                onClick={() => setSidebarTab('graph')}
              >Graph</button>
            </div>
            <div class="sidebar-actions">
              {sidebarTab === 'notes' && (
                <>
                  <button
                    class="primary btn-icon"
                    title="New note"
                    aria-label="New note"
                    onClick={() => navigate('/new')}
                  >+</button>
                  <button
                    class="btn-icon"
                    title="Upload note (Markdown or HTML)"
                    aria-label="Upload note"
                    onClick={() => uploadRef.current?.click()}
                  >⬆</button>
                  <input
                    ref={uploadRef}
                    type="file"
                    accept=".md,.markdown,text/markdown,text/plain,.html,.htm,text/html"
                    style="display:none"
                    onChange={handleUpload}
                  />
                </>
              )}
              {sidebarTab === 'tags' && (
                <button
                  class="primary btn-icon"
                  title="New tag"
                  aria-label="New tag"
                  onClick={() => void handleNewTag()}
                >+</button>
              )}
              <button
                class="btn-icon sidebar-reload"
                title={sidebarTab === 'notes' ? 'Reload notes' : sidebarTab === 'tags' ? 'Reload tags' : 'Reload graph'}
                aria-label={sidebarTab === 'notes' ? 'Reload notes' : sidebarTab === 'tags' ? 'Reload tags' : 'Reload graph'}
                onClick={refreshList}
              >↺</button>
            </div>
          </div>
          <div class="sidebar-content">
            {sidebarTab === 'notes' && (
              <NoteList
                activeSlug={activeSlug}
                activeTags={route.type === 'list' ? route.tags : []}
                listKey={listKey}
                sortField={sortField}
                sortOrder={sortOrder}
                onSortChange={changeSort}
              />
            )}
            {sidebarTab === 'tags' && (
              <TagManager
                listKey={listKey}
                onMutate={refreshList}
                onOpenTag={openTag}
              />
            )}
            {sidebarTab === 'graph' && (
              <NotesGraph listKey={listKey} activeSlug={activeSlug} />
            )}
          </div>
        </aside>
        <main>
          {route.type === 'list' && (
            <NotesOverview
              activeTags={route.tags}
              listKey={listKey}
              onMutate={refreshList}
              sortField={sortField}
              sortOrder={sortOrder}
            />
          )}
          {route.type === 'new' && <NoteEditor onSave={refreshList} />}
          {route.type === 'view' && <NoteView slug={route.slug} onDelete={refreshList} />}
          {route.type === 'edit' && <NoteEditor slug={route.slug} onSave={refreshList} />}
        </main>
      </div>
      <Toast />
    </>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
