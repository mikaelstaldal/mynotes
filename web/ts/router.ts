// Minimal hash-based router. The Go server serves index.html for unknown paths,
// and the client owns navigation via the URL fragment (#/...). No history API,
// so deep links and the back button work without server cooperation.

export type Route =
  | { type: 'list' }
  | { type: 'new' }
  | { type: 'edit'; slug: string };

function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.split('/').filter(Boolean);

  if (parts[0] === 'new') return { type: 'new' };
  if (parts[0] === 'notes' && parts[1]) {
    return { type: 'edit', slug: parts[1] };
  }
  return { type: 'list' };
}

export function currentRoute(): Route {
  return parseRoute(window.location.hash);
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

export function onRouteChange(cb: (route: Route) => void): () => void {
  const handler = () => cb(currentRoute());
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}
