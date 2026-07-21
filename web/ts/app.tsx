import { render } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { currentRoute, onRouteChange, type Route } from './router.js';
import { getConfig, saveConfig } from './util/config.js';
import { isValidSlug } from './util/slug.js';
import { api, type SortField, type SortOrder } from './api/client.js';
import { NoteList } from './views/NoteList.js';
import { NotesOverview } from './views/NotesOverview.js';
import { NoteEditor } from './views/NoteEditor.js';
import { NoteView } from './views/NoteView.js';
import { Toast } from './components/Toast.js';

function App() {
  const [route, setRoute] = useState<Route>(currentRoute());
  const [listKey, setListKey] = useState(0);
  const [sortField, setSortField] = useState<SortField>(() => getConfig().sortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => getConfig().sortOrder);

  useEffect(() => onRouteChange(setRoute), []);

  // Apply the persisted theme to the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = getConfig().theme;
  }, []);

  const refreshList = useCallback(() => setListKey(k => k + 1), []);

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
          <a class="brand sidebar-brand" href="/">MyNotes</a>
          <NoteList
            activeSlug={activeSlug}
            activeTags={route.type === 'list' ? route.tags : []}
            listKey={listKey}
            onMutate={refreshList}
            sortField={sortField}
            sortOrder={sortOrder}
            onSortChange={changeSort}
          />
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
