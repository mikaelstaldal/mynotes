import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { currentRoute, onRouteChange, type Route } from './router.js';
import { getConfig } from './util/config.js';
import { NoteList } from './views/NoteList.js';
import { NoteEditor } from './views/NoteEditor.js';
import { NoteView } from './views/NoteView.js';
import { Toast } from './components/Toast.js';

function App() {
  const [route, setRoute] = useState<Route>(currentRoute());

  useEffect(() => onRouteChange(setRoute), []);

  // Apply the persisted theme to the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = getConfig().theme;
  }, []);

  return (
    <>
      <header class="app-header">
        <a class="brand" href="/">MyNotes</a>
      </header>
      <main>
        {route.type === 'list' && <NoteList />}
        {route.type === 'new' && <NoteEditor />}
        {route.type === 'view' && <NoteView slug={route.slug} />}
        {route.type === 'edit' && <NoteEditor slug={route.slug} />}
      </main>
      <Toast />
    </>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
