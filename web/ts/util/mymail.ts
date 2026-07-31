// The MyMail base URL the "Send as email" action posts to: the single source of
// truth for whether the integration is available at all.
//
// Two sources, in this order:
//   1. the user's Settings override, persisted in localStorage (config.ts);
//   2. the URL the server derived from -public-url and injected into the page
//      (serverconfig.ts), which only exists for a path-scoped deployment.
// Empty means "MyMail is not configured", which the note toolbar reads as
// "hide the email action".
//
// A cross-origin MyMail cannot work: the page's Content-Security-Policy sets no
// connect-src, so fetch() falls back to `default-src 'self'` and the browser
// blocks the request before it leaves. validateMymailUrl() rejects such a URL
// as it is entered rather than letting it fail at send time.

import { getConfig, saveConfig } from './config.js';
import { isDemo, mymailUrl as injectedMymailUrl } from './serverconfig.js';

// Fired on `document` whenever the override changes, so a note toolbar already
// on screen shows or hides its email action without a reload.
const MYMAIL_EVENT = 'mynotes-mymailchange';

// The MyMail base URL in effect, without a trailing slash, or '' when the
// integration is not configured.
export function getMymailUrl(): string {
  // A demo has no server to relay a message, so the integration stays off
  // however localStorage was edited.
  if (isDemo()) return '';
  return getConfig().mymailUrl ?? injectedMymailUrl();
}

// The URL the server derived, or '' — what clearing the override falls back to.
export function serverMymailUrl(): string {
  return injectedMymailUrl();
}

// The user's override as stored, or '' when they have not set one.
export function mymailOverride(): string {
  return getConfig().mymailUrl ?? '';
}

// Validate a URL typed into Settings, returning '' when it is acceptable and
// otherwise the message to show. An empty string is acceptable: it clears the
// override and falls back to the server-derived URL.
export function validateMymailUrl(url: string): string {
  if (url === '') return '';
  if (url.length > 500) return 'URL is too long.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter an absolute URL, e.g. https://example.com/mymail';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http and https URLs are allowed.';
  }
  if (parsed.search || parsed.hash) {
    return 'The URL must not have a query string or fragment.';
  }
  if (parsed.origin !== window.location.origin) {
    return `MyMail must be on the same origin as MyNotes (${window.location.origin}) — the Content-Security-Policy blocks requests to any other origin.`;
  }
  return '';
}

// Persist the override — '' clears it — and notify subscribers. The caller is
// expected to have validated the URL; anything the stored-value check in
// config.ts rejects is dropped on the next read regardless.
export function setMymailUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  const config = getConfig();
  if (trimmed === '') {
    delete config.mymailUrl;
  } else {
    config.mymailUrl = trimmed;
  }
  saveConfig(config);
  document.dispatchEvent(new CustomEvent<string>(MYMAIL_EVENT, { detail: getMymailUrl() }));
}

// Subscribe to changes of the effective URL; returns an unsubscribe function.
export function onMymailChange(cb: (url: string) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<string>).detail);
  document.addEventListener(MYMAIL_EVENT, handler);
  return () => document.removeEventListener(MYMAIL_EVENT, handler);
}
