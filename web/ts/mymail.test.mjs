// node:test coverage for the MyMail URL resolution in web/ts/util/mymail.ts
// (exercised via its compiled output, web/static/util/mymail.js). Run via
// build.sh or directly:
//   node --import ./web/ts/test-preload.mjs --test web/ts/mymail.test.mjs
//
// What is under test is which URL the "Send as email" action ends up posting
// to: the Settings override when the user set one, the server-derived URL
// otherwise, and nothing at all in a demo. The validation is tested alongside
// it because a URL that passes it but cannot work — a cross-origin one, which
// the page's `default-src 'self'` blocks — would fail only at send time, with
// no way for the user to tell why.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { JSDOM } = await import(path.resolve(__dirname, 'vendor/test/jsdom.js'));
const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.com/mynotes/',
});
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.CustomEvent = window.CustomEvent;

const {
  getMymailUrl,
  serverMymailUrl,
  mymailOverride,
  setMymailUrl,
  validateMymailUrl,
  onMymailChange,
} = await import(path.resolve(__dirname, '../static/util/mymail.js'));

const DERIVED = 'https://example.com/mymail';

beforeEach(() => {
  localStorage.clear();
  window.__serverConfig = { mymailUrl: DERIVED };
});

test('falls back to the URL the server derived', () => {
  assert.equal(getMymailUrl(), DERIVED);
  assert.equal(serverMymailUrl(), DERIVED);
  assert.equal(mymailOverride(), '');
});

test('no server URL and no override means the integration is off', () => {
  window.__serverConfig = undefined;
  assert.equal(getMymailUrl(), '');
});

test('the override wins over the server URL and survives a reload', () => {
  setMymailUrl('https://example.com/mail/');
  // The trailing slash is dropped: callers append the API path to this base.
  assert.equal(getMymailUrl(), 'https://example.com/mail');
  assert.equal(mymailOverride(), 'https://example.com/mail');
  assert.equal(serverMymailUrl(), DERIVED);
  assert.equal(
    JSON.parse(localStorage.getItem('mynotes-settings')).mymailUrl,
    'https://example.com/mail',
  );
});

test('clearing the override restores the server URL', () => {
  setMymailUrl('https://example.com/mail');
  setMymailUrl('');
  assert.equal(getMymailUrl(), DERIVED);
  assert.equal(mymailOverride(), '');
  assert.equal('mymailUrl' in JSON.parse(localStorage.getItem('mynotes-settings')), false);
});

test('an override the stored-value check rejects is ignored', () => {
  // localStorage is user-editable, so a stored value is never trusted: a
  // javascript: URL must not reach fetch() as a request base.
  localStorage.setItem('mynotes-settings', JSON.stringify({ mymailUrl: 'javascript:alert(1)' }));
  assert.equal(getMymailUrl(), DERIVED);
  assert.equal(mymailOverride(), '');
});

test('a demo never offers MyMail, whatever localStorage says', () => {
  window.__serverConfig = { demo: true };
  setMymailUrl('https://example.com/mail');
  assert.equal(getMymailUrl(), '');
});

test('subscribers see the effective URL change', () => {
  const seen = [];
  const unsubscribe = onMymailChange((url) => seen.push(url));
  setMymailUrl('https://example.com/mail');
  setMymailUrl('');
  unsubscribe();
  setMymailUrl('https://example.com/elsewhere');
  assert.deepEqual(seen, ['https://example.com/mail', DERIVED]);
});

test('accepts an absolute same-origin http(s) URL, and an empty one', () => {
  assert.equal(validateMymailUrl(''), '');
  assert.equal(validateMymailUrl('https://example.com/mymail'), '');
  assert.equal(validateMymailUrl('https://example.com'), '');
});

test('rejects what cannot work as a MyMail base URL', () => {
  for (const url of [
    'mymail',                          // relative
    'ftp://example.com/mymail',        // not http(s)
    'javascript:alert(1)',             // not http(s)
    'https://mail.example.com/',       // cross-origin: blocked by the CSP
    'http://example.com/mymail',       // cross-origin: scheme differs
    'https://example.com:8443/mymail', // cross-origin: port differs
    'https://example.com/mymail?a=1',  // query would break the path concatenation
    'https://example.com/mymail#x',    // as would a fragment
    `https://example.com/${'a'.repeat(500)}`,
  ]) {
    assert.notEqual(validateMymailUrl(url), '', `expected ${url} to be rejected`);
  }
});
