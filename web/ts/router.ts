// History-API path router. The Go server serves index.html for any path that
// does not match a real static file, so deep links and the back button work
// without any server-side route enumeration.

import { base } from './basepath.js';

export type Route =
  | { type: 'list'; tags: string[] }
  | { type: 'new' }
  | { type: 'view'; slug: string }
  | { type: 'edit'; slug: string };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Build the SPA path for a set of tag filters: '/' when empty, else
// /tags/<a,b,c>. Slugs never contain a comma, so it is a safe separator.
export function tagsPath(tags: string[]): string {
  return tags.length ? `/tags/${tags.join(',')}` : '/';
}

// Strip the deployment base prefix so parseRoute always sees a root-relative path.
function stripBase(pathname: string): string {
  if (!base) return pathname;
  return pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;
}

function parseRoute(pathname: string): Route {
  const parts = stripBase(pathname).split('/').filter(Boolean);
  if (parts[0] === 'new') return { type: 'new' };
  if (parts[0] === 'notes' && parts[1]) {
    if (parts[2] === 'edit') return { type: 'edit', slug: parts[1] };
    return { type: 'view', slug: parts[1] };
  }
  // Tag permalink: /tags/<slug> or /tags/<a,b,c> (comma-separated, AND filter).
  // Keep only well-formed slugs and drop duplicates so the filter is normalized.
  if (parts[0] === 'tags' && parts[1]) {
    const tags = [...new Set(parts[1].split(',').filter(s => SLUG_RE.test(s)))];
    return { type: 'list', tags };
  }
  return { type: 'list', tags: [] };
}

export function currentRoute(): Route {
  return parseRoute(window.location.pathname);
}

// The current in-app (root-relative, base-stripped) path — suitable for passing
// back to navigate(). Used to remember where a navigation originated.
export function currentPath(): string {
  return stripBase(window.location.pathname);
}

// A navigation guard returns true to allow the navigation, false to block it.
type NavigationGuard = () => boolean;
let guard: NavigationGuard | null = null;

export function setNavigationGuard(fn: NavigationGuard | null): void {
  guard = fn;
}

// path is always a root-relative SPA path (e.g. '/notes/slug'). navigate
// prepends the deployment base so pushState produces the full URL path. An
// optional state object is stored on the history entry (e.g. where a navigation
// originated) and can be read back via history.state.
export function navigate(path: string, state: unknown = null): void {
  if (guard && !guard()) return;
  // Navigating to the path we're already on replaces the current history entry
  // rather than stacking a duplicate. This matters when a note created in place
  // (after following a link to a non-existent note) is saved: the editor and the
  // resulting note view share the same URL, so a push would leave two identical
  // entries and require two back-button presses to leave.
  if (path === currentPath()) {
    history.replaceState(state, '', base + path);
  } else {
    history.pushState(state, '', base + path);
  }
  // push/replaceState alone does not fire popstate; dispatch one so listeners update.
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
}

// Returns true for paths that the SPA owns. An in-app path is always
// root-relative (e.g. /notes/slug or <base>/notes/slug); anything else — an
// absolute URL, a protocol-relative //host path, an /api/ endpoint, or a
// blob:/data:/mailto: scheme — gets a real browser navigation.
function isInAppPath(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  // Strip the base prefix before checking for the /api/ segment.
  const local = base && href.startsWith(base) ? href.slice(base.length) : href;
  return !local.startsWith('/api/');
}

export function onRouteChange(cb: (route: Route) => void): () => void {
  const onPopState = () => cb(currentRoute());
  window.addEventListener('popstate', onPopState);

  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest('a');
    if (!a) return;
    // Let the browser handle download anchors (e.g. the client-side "Download
    // HTML" blob: link) and anything targeting another browsing context.
    if (a.hasAttribute('download') || a.target) return;
    const href = a.getAttribute('href');
    if (!href || !isInAppPath(href)) return;
    e.preventDefault();
    // href may already carry the base prefix (e.g. from ${base}/notes/slug in
    // templates); strip it before calling navigate, which re-adds it.
    const localPath = base && href.startsWith(base) ? href.slice(base.length) : href;
    // Record where this navigation started so that, if it lands on a
    // non-existent note, the new-note editor's Cancel can return to the
    // originating note (e.g. a wiki link to a note that doesn't exist yet)
    // instead of falling back to the main page.
    navigate(localPath, { returnTo: currentPath() });
  };
  document.addEventListener('click', onClick);

  return () => {
    window.removeEventListener('popstate', onPopState);
    document.removeEventListener('click', onClick);
  };
}
