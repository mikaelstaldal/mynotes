// History-API path router. The Go server serves index.html for any path that
// does not match a real static file, so deep links and the back button work
// without any server-side route enumeration.

import { base } from './basepath.js';

export type Route =
  | { type: 'list'; tag?: string }
  | { type: 'new' }
  | { type: 'view'; slug: string }
  | { type: 'edit'; slug: string };

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
  // Tag permalink: /tags/<slug>.
  if (parts[0] === 'tags' && parts[1]) return { type: 'list', tag: parts[1] };
  return { type: 'list' };
}

export function currentRoute(): Route {
  return parseRoute(window.location.pathname);
}

// A navigation guard returns true to allow the navigation, false to block it.
type NavigationGuard = () => boolean;
let guard: NavigationGuard | null = null;

export function setNavigationGuard(fn: NavigationGuard | null): void {
  guard = fn;
}

// path is always a root-relative SPA path (e.g. '/notes/slug'). navigate
// prepends the deployment base so pushState produces the full URL path.
export function navigate(path: string): void {
  if (guard && !guard()) return;
  history.pushState(null, '', base + path);
  // pushState alone does not fire popstate; dispatch one so listeners update.
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}

// Returns true for paths that the SPA owns. API and external URLs are excluded
// so that download links and absolute URLs get real browser navigations.
function isInAppPath(href: string): boolean {
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) return false;
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
    const href = a.getAttribute('href');
    if (!href || !isInAppPath(href)) return;
    e.preventDefault();
    // href may already carry the base prefix (e.g. from ${base}/notes/slug in
    // templates); strip it before calling navigate, which re-adds it.
    const localPath = base && href.startsWith(base) ? href.slice(base.length) : href;
    navigate(localPath);
  };
  document.addEventListener('click', onClick);

  return () => {
    window.removeEventListener('popstate', onPopState);
    document.removeEventListener('click', onClick);
  };
}
