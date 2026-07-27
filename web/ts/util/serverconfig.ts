// Deployment configuration injected by the server, not by the user.
//
// When MyNotes is deployed under a path (-public-url https://example.com/mynotes),
// main.go splices an inline <script> into index.html that sets
// window.__serverConfig with the base URL of the sibling MyMail instance
// assumed at /mymail on the same origin. Nothing is injected for a root
// deployment, so the value is absent far more often than not.
//
// The value originates from the server, but it is read back out of a global
// that page script could have overwritten, so it is re-validated here before
// being used to build a request URL.

declare global {
  interface Window {
    __serverConfig?: { mymailUrl?: string; demo?: boolean };
  }
}

// Absolute http(s) URL with no characters that could smuggle a second URL
// component past the concatenation in the callers.
const ABSOLUTE_HTTP_URL = /^https?:\/\/[^\s"'<>\\]+$/;

// The MyMail base URL without a trailing slash, or '' when the MyMail
// integration is not configured. Callers treat '' as "hide the email action".
export function mymailUrl(): string {
  const url = window.__serverConfig?.mymailUrl;
  if (typeof url !== 'string' || !ABSOLUTE_HTTP_URL.test(url)) return '';
  return url.replace(/\/+$/, '');
}

// Whether this is the backend-less demo build (mynotes -demo-server, or a
// bundle written by -demo-bundle). The app then starts a service worker that
// answers the REST API from browser-local storage; see web/ts/demo-client.ts.
export function isDemo(): boolean {
  return window.__serverConfig?.demo === true;
}
