import { render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { currentRoute, onRouteChange, navigate, tagsPath, type Route } from './router.js';
import { getConfig, saveConfig } from './util/config.js';
import { getTheme, applyTheme, toggleTheme, type Theme } from './util/theme.js';
import { isValidSlug, slugFromTitle } from './util/slug.js';
import { showToast } from './util/toast.js';
import { promptDialog } from './util/dialog.js';
import { isDemo } from './util/serverconfig.js';
import { api, type SortField, type SortOrder } from './api/client.js';
import { NoteList } from './views/NoteList.js';
import { NotesOverview } from './views/NotesOverview.js';
import { NoteEditor } from './views/NoteEditor.js';
import { NoteView } from './views/NoteView.js';
import { TagManager } from './views/TagManager.js';
import { NotesGraph } from './views/NotesGraph.js';
import { Toast } from './components/Toast.js';
import { Dialogs } from './components/Dialog.js';
import { Icon } from './components/Icon.js';
import { DemoDialog, demoNoticeSeen, markDemoNoticeSeen } from './components/DemoDialog.js';
import { SettingsDialog } from './components/SettingsDialog.js';

type SidebarTab = 'notes' | 'tags' | 'graph';

function App() {
  const [route, setRoute] = useState<Route>(currentRoute());
  const [listKey, setListKey] = useState(0);
  const [sortField, setSortField] = useState<SortField>(() => getConfig().sortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => getConfig().sortOrder);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(
    () => currentRoute().type === 'graph' ? 'graph' : 'notes',
  );
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  // The one-time "this is a demo" notice, shown before anything is typed.
  const [showDemoNotice, setShowDemoNotice] = useState(() => isDemo() && !demoNoticeSeen());
  const [showSettings, setShowSettings] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => onRouteChange(setRoute), []);

  // Landing on the /graph route (Graph tab, a deep link, or the back button)
  // selects the Graph sidebar tab so the small graph accompanies the large one.
  useEffect(() => {
    if (route.type === 'graph') setSidebarTab('graph');
  }, [route.type]);

  // Apply the persisted theme to the document root at startup.
  useEffect(() => { applyTheme(theme); }, []);

  // Flip light/dark; toggleTheme persists, applies, and notifies subscribers
  // (e.g. open Mermaid diagrams), and returns the new theme for the button icon.
  const handleToggleTheme = useCallback(() => setThemeState(toggleTheme()), []);

  const refreshList = useCallback(() => setListKey(k => k + 1), []);

  const dismissDemoNotice = useCallback(() => {
    markDemoNoticeSeen();
    setShowDemoNotice(false);
  }, []);

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
    const name = await promptDialog({
      title: 'New tag',
      label: 'Tag name',
      // The backend slug limit; the name is slugified, so this is a generous cap.
      maxLength: 100,
      confirmLabel: 'Create tag',
    });
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

  // Selecting the Notes or Tags tab while the large graph fills the main panel
  // returns the main panel to the note list, so the sidebar and main panel agree.
  const selectTab = useCallback((tab: SidebarTab) => {
    setSidebarTab(tab);
    if (tab === 'graph') {
      navigate('/graph');
    } else if (route.type === 'graph') {
      navigate('/');
    }
  }, [route.type]);

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
                onClick={() => selectTab('notes')}
              >Notes</button>
              <button
                role="tab"
                aria-selected={sidebarTab === 'tags'}
                class={`sidebar-tab${sidebarTab === 'tags' ? ' active' : ''}`}
                onClick={() => selectTab('tags')}
              >Tags</button>
              <button
                role="tab"
                aria-selected={sidebarTab === 'graph'}
                class={`sidebar-tab${sidebarTab === 'graph' ? ' active' : ''}`}
                onClick={() => selectTab('graph')}
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
                  ><Icon name="plus" size={16} /></button>
                  <button
                    class="btn-icon"
                    title="Upload note (Markdown or HTML)"
                    aria-label="Upload note"
                    onClick={() => uploadRef.current?.click()}
                  ><Icon name="upload" size={16} /></button>
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
                ><Icon name="plus" size={16} /></button>
              )}
              <button
                class="btn-icon sidebar-reload"
                title={sidebarTab === 'notes' ? 'Reload notes' : sidebarTab === 'tags' ? 'Reload tags' : 'Reload graph'}
                aria-label={sidebarTab === 'notes' ? 'Reload notes' : sidebarTab === 'tags' ? 'Reload tags' : 'Reload graph'}
                onClick={refreshList}
              ><Icon name="rotate-ccw" size={16} /></button>
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
          <div class="sidebar-footer">
            {isDemo() && (
              <p class="demo-badge" role="status">
                <Icon name="flask-conical" size={14} />
                <span>Demo — notes are stored in this browser only</span>
              </p>
            )}
            <div class="sidebar-footer-actions">
              <button
                class="btn-icon theme-toggle"
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-pressed={theme === 'dark'}
                onClick={handleToggleTheme}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
              </button>
              {/* Settings holds the MyMail URL and nothing else, and a demo has
                  no server to relay a message — so it is offered only outside
                  demo mode, where it would be an empty dialog. */}
              {!isDemo() && (
                <button
                  class="btn-icon settings-open"
                  title="Settings"
                  aria-label="Settings"
                  onClick={() => setShowSettings(true)}
                >
                  <Icon name="settings" size={16} />
                  <span>Settings</span>
                </button>
              )}
            </div>
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
          {route.type === 'graph' && (
            <NotesGraph listKey={listKey} activeSlug={activeSlug} variant="main" />
          )}
        </main>
      </div>
      <Toast />
      <Dialogs />
      {showDemoNotice && <DemoDialog onClose={dismissDemoNotice} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </>
  );
}

// In demo mode the backend is a service worker that has to be installed and in
// control before the app issues its first request, so rendering waits on it.
// The import is dynamic so a normal build never fetches the demo code at all.
async function start(root: HTMLElement): Promise<void> {
  if (isDemo()) {
    try {
      const { startDemoBackend } = await import('./demo-client.js');
      await startDemoBackend();
    } catch (e) {
      root.textContent = e instanceof Error ? e.message : 'The demo backend failed to start.';
      return;
    }
  }
  render(<App />, root);
}

const root = document.getElementById('app');
if (root) void start(root);
