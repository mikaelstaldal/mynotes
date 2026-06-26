// Centralized API client. All network access goes through `request<T>` so that
// retry-on-network-error, 401 handling, and error-body parsing live in exactly
// one place. Request/response shapes come from `types.ts`, which is generated
// from openapi.yaml by openapi-typescript (never edit it by hand).

import { showNetworkErrorToast } from '../util/toast.js';
import type { components } from './types.js';

export type Note = components['schemas']['Note'];
export type NoteSummary = components['schemas']['NoteSummary'];
export type NoteList = components['schemas']['NoteList'];
export type CreateNoteRequest = components['schemas']['CreateNoteRequest'];
export type UpdateNoteRequest = components['schemas']['UpdateNoteRequest'];

const BASE = '/api/v1';

export class NotFoundError extends Error {
  constructor() { super('Not found'); this.name = 'NotFoundError'; }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// fetchWithRetry retries safe (GET/HEAD) requests once automatically on a
// transient network failure, then surfaces a persistent toast with a Retry
// button. It resolves only once a response is obtained or the user retries.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const isSafe = ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
  let autoRetried = false;
  for (;;) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // not a network error
      if (isSafe && !autoRetried) {
        await delay(2000);
        autoRetried = true;
        continue;
      }
      await new Promise<void>(resolve => {
        showNetworkErrorToast('Network error. Please check your connection.', resolve);
      });
    }
  }
}

async function requestRaw<T>(
  method: string,
  path: string,
  body: string,
  contentType: string,
): Promise<T> {
  const init: RequestInit = { method, headers: { 'Content-Type': contentType }, body };
  const res = await fetchWithRetry(BASE + path, init);
  if (res.status === 401) { window.location.reload(); throw new Error('Unauthorized'); }
  if (res.status === 404) throw new NotFoundError();
  if (res.status === 204) return undefined as T;
  const data = await res.json() as unknown;
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

async function request<T>(method: string, path: string, body?: unknown, notFoundOn: number[] = []): Promise<T> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetchWithRetry(BASE + path, init);

  if (res.status === 401) { window.location.reload(); throw new Error('Unauthorized'); }
  if (res.status === 404 || notFoundOn.includes(res.status)) throw new NotFoundError();
  if (res.status === 204) return undefined as T;

  const data = await res.json() as unknown;
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  notes: {
    list: (opts: { q?: string; limit?: number; offset?: number } = {}) => {
      const p = new URLSearchParams();
      if (opts.q) p.set('q', opts.q);
      if (opts.limit != null) p.set('limit', String(opts.limit));
      if (opts.offset != null) p.set('offset', String(opts.offset));
      const qs = p.toString();
      return request<NoteList>('GET', `/notes${qs ? `?${qs}` : ''}`);
    },

    get: (slug: string) =>
      request<Note>('GET', `/notes/${slug}`, undefined, [400]),

    create: (body: CreateNoteRequest) =>
      request<Note>('POST', '/notes', body),

    update: (slug: string, body: UpdateNoteRequest) =>
      request<Note>('PATCH', `/notes/${slug}`, body),

    delete: (slug: string) =>
      request<void>('DELETE', `/notes/${slug}`),

    importHtml: (html: string): Promise<Note> =>
      requestRaw<Note>('POST', '/import', html, 'text/html'),

    importMarkdown: (markdown: string): Promise<Note> =>
      requestRaw<Note>('POST', '/import', markdown, 'text/markdown'),
  },
};
