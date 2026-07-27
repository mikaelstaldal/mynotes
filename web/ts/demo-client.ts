// The page half of demo mode. Loaded — dynamically, so a normal build never
// downloads it — only when the server marks the deployment as a demo (see
// util/serverconfig.ts).
//
// It has exactly two jobs: get the service worker installed and in control
// before the app makes its first request, and answer the one question the
// worker cannot answer for itself (parsing HTML, which needs a DOM).

import { htmlToMarkdown } from './util/htmlmd.js';

/** Must match HTML_CONVERT_MESSAGE in demo-sw.ts. */
const HTML_CONVERT_MESSAGE = 'mynotes-demo:html-to-markdown';

/** Must match CLAIM_MESSAGE in demo-sw.ts. */
const CLAIM_MESSAGE = 'mynotes-demo:claim';

/**
 * How long an already-active worker gets to claim this page before we give up
 * on being claimed and reload instead. Short: the worker is running and the
 * message is a round trip inside the browser, so this is not a network wait.
 */
const CLAIM_TIMEOUT_MS = 3_000;

/** Session flag marking the one reload below, so it can never happen twice. */
const RELOADED_KEY = 'mynotes-demo:reloaded';

/**
 * Registers the demo backend and resolves once it is controlling this page.
 *
 * Waiting matters: until a service worker controls the page, its fetch handler
 * does not see anything the page requests, so an app that started rendering
 * immediately would fire its first note list at a server that is not there. The
 * worker calls clients.claim() on activation, which is what lets a first-ever
 * load be controlled without a reload.
 *
 * A hard reload (Ctrl-Shift-R) needs more than that wait: the browser loads such
 * a navigation with the worker bypassed, so the page starts uncontrolled even
 * though the worker is already installed and activated. Nothing fires activate
 * again, so the clients.claim() there never runs and no controllerchange is
 * coming — waiting alone would just time out. So when a worker is already
 * active, ask it to claim this page, and fall back to one plain reload (which is
 * controlled from the start) if that does not take.
 *
 * Throws when service workers are unavailable — over plain HTTP on a non-local
 * host, say, or in a private window in some browsers — because there is no
 * backend to fall back to.
 */
export async function startDemoBackend(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This demo needs service worker support, which this browser does not offer.');
  }

  navigator.serviceWorker.addEventListener('message', onWorkerMessage);
  // addEventListener alone leaves the message queue blocked — only assigning
  // onmessage starts it implicitly — so ask for delivery explicitly.
  navigator.serviceWorker.startMessages();

  // Resolve against <base href> so the worker is registered from the
  // deployment root and its scope covers the whole app.
  const workerURL = new URL('demo-sw.js', document.baseURI).href;
  const registration = await navigator.serviceWorker.register(workerURL);
  if (navigator.serviceWorker.controller !== null) {
    sessionStorage.removeItem(RELOADED_KEY);
    return;
  }

  // An active worker means this is the bypassed-navigation case, not a
  // first-ever load, so it gets the short deadline and the reload fallback.
  const active = registration.active;
  if (active !== null) active.postMessage({ type: CLAIM_MESSAGE });
  const claimed = await controlled(active !== null ? CLAIM_TIMEOUT_MS : 15_000);
  if (claimed) {
    sessionStorage.removeItem(RELOADED_KEY);
    return;
  }

  if (active !== null && sessionStorage.getItem(RELOADED_KEY) === null) {
    sessionStorage.setItem(RELOADED_KEY, '1');
    location.reload();
    // Hang: the page is going away, and resolving would render an app whose
    // backend is not there.
    await new Promise<never>(() => undefined);
  }
  sessionStorage.removeItem(RELOADED_KEY);
  throw new Error('The demo backend did not start up in time.');
}

/** Resolves true once a worker controls this page, false at the deadline. */
function controlled(timeoutMS: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onChange = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve(false);
    }, timeoutMS);
    navigator.serviceWorker.addEventListener('controllerchange', onChange, { once: true });
  });
}

/**
 * Converts an HTML document to Markdown on the worker's behalf and replies on
 * the port it supplied. Failures are reported as a message rather than thrown,
 * so the worker can turn them into a 400 instead of timing out.
 */
function onWorkerMessage(event: MessageEvent): void {
  const data = event.data as { type?: string; html?: string } | null;
  if (data === null || data.type !== HTML_CONVERT_MESSAGE) return;
  const port = event.ports[0];
  if (port === undefined) return;
  try {
    port.postMessage(htmlToMarkdown(data.html ?? ''));
  } catch (err) {
    port.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
}
