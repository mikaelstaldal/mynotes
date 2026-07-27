// The demo service worker's entry point: lifecycle, request interception, and
// the one call it has to hand back to the page.
//
// Registered only by a demo build (see web/ts/demo-client.ts), it intercepts
// every same-scope /api/v1 request and answers it from browser-local storage,
// so the whole web UI runs with no server behind it. Requests for anything else
// — the app's own scripts, styles, and vendor bundles — are left alone and go
// to the network as usual.
//
// See demo/model.ts for why these are globals rather than module exports, and
// why this is a classic worker script.

// The demo backend, loaded synchronously into this worker's global scope. Paths
// are relative to this script, which sits at the deployment root — that is what
// gives the worker a scope covering the whole app.
importScripts(
  'demo/model.js',
  'demo/text.js',
  'demo/store.js',
  'demo/icons.js',
  'demo/api.js',
);

/** `self`, typed. lib.webworker declares it as the generic worker scope. */
const sw = self as unknown as ServiceWorkerGlobalScope;

/** The path prefix every emulated endpoint sits under, relative to the scope. */
const API_PREFIX = 'api/v1';

/** The message this worker sends a client to have HTML converted (see below). */
const HTML_CONVERT_MESSAGE = 'mynotes-demo:html-to-markdown';

/** How long to wait for that client to answer before giving up. */
const HTML_CONVERT_TIMEOUT_MS = 15_000;

/**
 * The registration scope: the deployment's base path, since the page registers
 * the worker from its own directory. Every URL the demo resolves — the seed
 * document, the Lucide bundle — is relative to this, so a bundle works at the
 * origin root and under a path alike.
 */
function scopeURL(): URL {
  return new URL(sw.registration.scope);
}

function seedURL(): string {
  return new URL(SEED_FILE_NAME, scopeURL()).href;
}

/** Must match demo.SeedFileName in internal/demo/bundle.go. */
const SEED_FILE_NAME = 'demo-data.json';

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Take over as soon as installed, then claim the pages that are already open:
// the page registers the worker and waits for it, so without claiming, the very
// first load would find no controller and have to reload itself.
sw.addEventListener('install', () => {
  sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await sw.clients.claim();
    // Seed now rather than on the first API call, so the initial note list does
    // not wait on a fetch of the demo content.
    await withStore(async () => undefined);
  })());
});

// ── Interception ─────────────────────────────────────────────────────────────

sw.addEventListener('fetch', (event) => {
  const path = apiPath(event.request.url);
  if (path !== null) {
    event.respondWith(handleApiRequest(path, event.request, event.clientId));
    return;
  }
  if (event.request.mode === 'navigate' && inScope(event.request.url)) {
    event.respondWith(navigate(event.request));
    return;
  }
  // Anything else — scripts, styles, vendor bundles — goes to the network.
});

/**
 * Serves a page navigation, falling back to the SPA shell for a path that is
 * not a file. Deep links like /notes/my-note are client-side routes: the
 * MyNotes server rewrites them to index.html, and a static host generally will
 * not, so the worker does it instead and the bundle works on any of them.
 *
 * The one gap is a deep link opened before this worker has ever been installed
 * — nothing is intercepting yet, so that first request is the host's to answer.
 */
async function navigate(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.status !== 404) return response;
  } catch {
    // Offline, or the host refused the request: fall through to the shell.
  }
  return fetch(new URL('index.html', scopeURL()).href);
}

function inScope(requestURL: string): boolean {
  const url = new URL(requestURL);
  const scope = scopeURL();
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}

/**
 * The API path of a request, or null when it is not an API request this worker
 * serves. Returns the part after the /api/v1 prefix with a leading slash, so
 * "https://host/notes-app/api/v1/notes/x" under scope "/notes-app/" yields
 * "/notes/x".
 */
function apiPath(requestURL: string): string | null {
  const url = new URL(requestURL);
  const scope = scopeURL();
  if (url.origin !== scope.origin) return null;
  if (!url.pathname.startsWith(scope.pathname)) return null;
  const rest = url.pathname.slice(scope.pathname.length);
  if (rest !== API_PREFIX && !rest.startsWith(API_PREFIX + '/')) return null;
  return rest.slice(API_PREFIX.length);
}

// ── HTML conversion, delegated to the page ───────────────────────────────────

/** What the page returns for a converted HTML document. */
interface ConvertedHTML {
  title: string;
  content: string;
}

/**
 * Converts an HTML document to Markdown by asking a client window to do it.
 *
 * This is the one operation the worker cannot do itself: converting HTML means
 * parsing it, and a service worker has no DOMParser. The page does, and it
 * already carries the converter, so the work is sent there over a MessageChannel
 * (see web/ts/demo-client.ts) and the result comes back here to be validated and
 * stored like any other note.
 */
async function htmlToMarkdown(clientId: string, html: string): Promise<ConvertedHTML> {
  const target = await conversionClient(clientId);
  if (target === null) {
    throw new ApiError(503, 'cannot import HTML: the page that made this request is gone');
  }
  return new Promise<ConvertedHTML>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(
      () => reject(new ApiError(504, 'timed out converting the HTML document')),
      HTML_CONVERT_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      const data = event.data as { error?: string; title?: string; content?: string };
      if (typeof data.error === 'string') reject(validationError('invalid HTML: ' + data.error));
      else resolve({ title: data.title ?? '', content: data.content ?? '' });
    };
    target.postMessage({ type: HTML_CONVERT_MESSAGE, html }, [channel.port2]);
  });
}

/** The client that made the request, or any open window as a fallback. */
async function conversionClient(clientId: string): Promise<Client | null> {
  if (clientId !== '') {
    const client = await sw.clients.get(clientId);
    if (client !== undefined) return client;
  }
  const windows = await sw.clients.matchAll({ type: 'window' });
  return windows.length > 0 ? windows[0] : null;
}
