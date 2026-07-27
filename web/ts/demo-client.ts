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

/**
 * Registers the demo backend and resolves once it is controlling this page.
 *
 * Waiting matters: until a service worker controls the page, its fetch handler
 * does not see anything the page requests, so an app that started rendering
 * immediately would fire its first note list at a server that is not there. The
 * worker calls clients.claim() on activation, which is what lets a first-ever
 * load be controlled without a reload.
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
  await navigator.serviceWorker.register(workerURL);
  if (navigator.serviceWorker.controller !== null) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The demo backend did not start up in time.')),
      15_000);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
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
