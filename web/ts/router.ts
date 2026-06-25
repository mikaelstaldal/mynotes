// History-API path router. The Go server serves index.html for any path that
// does not match a real static file, so deep links and the back button work
// without any server-side route enumeration.

export type Route =
  | { type: 'list' }
  | { type: 'new' }
  | { type: 'view'; slug: string }
  | { type: 'edit'; slug: string };

function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'new') return { type: 'new' };
  if (parts[0] === 'notes' && parts[1]) {
    if (parts[2] === 'edit') return { type: 'edit', slug: parts[1] };
    return { type: 'view', slug: parts[1] };
  }
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

export function navigate(path: string): void {
  if (guard && !guard()) return;
  history.pushState(null, '', path);
  // pushState alone does not fire popstate; dispatch one so listeners update.
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}

// Returns true for paths that the SPA owns. API and external URLs are excluded
// so that <a href="/api/v1/..."> and absolute URLs get real browser navigations.
function isInAppPath(href: string): boolean {
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) return false;
  if (href.startsWith('/api/')) return false;
  return true;
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
    navigate(href);
  };
  document.addEventListener('click', onClick);

  return () => {
    window.removeEventListener('popstate', onPopState);
    document.removeEventListener('click', onClick);
  };
}
