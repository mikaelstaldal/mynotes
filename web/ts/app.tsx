import { render } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { currentRoute, onRouteChange, type Route } from './router.js';
import { getConfig } from './util/config.js';
import { NoteList } from './views/NoteList.js';
import { NoteEditor } from './views/NoteEditor.js';
import { NoteView } from './views/NoteView.js';
import { Toast } from './components/Toast.js';

function App() {
  const [route, setRoute] = useState<Route>(currentRoute());
  const [listKey, setListKey] = useState(0);

  useEffect(() => onRouteChange(setRoute), []);

  // Apply the persisted theme to the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = getConfig().theme;
  }, []);

  const refreshList = useCallback(() => setListKey(k => k + 1), []);

  const activeSlug = (route.type === 'view' || route.type === 'edit') ? route.slug : undefined;

  return (
    <>
      <div class="app-body">
        <aside class="sidebar">
          <a class="brand sidebar-brand" href="/">MyNotes</a>
          <NoteList activeSlug={activeSlug} listKey={listKey} onMutate={refreshList} />
        </aside>
        <main>
          {route.type === 'list' && <p class="muted select-prompt">Select a note or create a new one.</p>}
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
