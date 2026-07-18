// Centralized API client. All network access goes through `request<T>` so that
// retry-on-network-error, 401 handling, and error-body parsing live in exactly
// one place. Request/response shapes come from `types.ts`, which is generated
// from openapi.yaml by openapi-typescript (never edit it by hand).

import { showNetworkErrorToast } from '../util/toast.js';
import type { components, operations } from './types.js';
import { base } from '../basepath.js';

export type Note = components['schemas']['Note'];
export type NoteSummary = components['schemas']['NoteSummary'];
export type NoteList = components['schemas']['NoteList'];
export type CreateNoteRequest = components['schemas']['CreateNoteRequest'];
export type UpdateNoteRequest = components['schemas']['UpdateNoteRequest'];
export type Artifact = components['schemas']['Artifact'];
export type Tag = components['schemas']['Tag'];
export type TagList = components['schemas']['TagList'];
export type CreateTagRequest = components['schemas']['CreateTagRequest'];

// Browse-list sort options, sourced from the generated listNotes query params
// so they stay in lockstep with openapi.yaml.
type ListNotesQuery = NonNullable<operations['listNotes']['parameters']['query']>;
export type SortField = NonNullable<ListNotesQuery['sort']>;
export type SortOrder = NonNullable<ListNotesQuery['order']>;

const BASE = base + '/api/v1';

export class NotFoundError extends Error {
  constructor() { super('Not found'); this.name = 'NotFoundError'; }
}

export class PreconditionFailedError extends Error {
  constructor() { super('Precondition failed'); this.name = 'PreconditionFailedError'; }
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

async function requestBinary<T>(
  method: string,
  path: string,
  body: Blob,
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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  notFoundOn: number[] = [],
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetchWithRetry(BASE + path, init);

  if (res.status === 401) { window.location.reload(); throw new Error('Unauthorized'); }
  if (res.status === 404 || notFoundOn.includes(res.status)) throw new NotFoundError();
  if (res.status === 412) throw new PreconditionFailedError();
  if (res.status === 204) return undefined as T;

  const data = await res.json() as unknown;
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  notes: {
    list: (opts: { q?: string; tag?: string; titlePrefix?: boolean; sort?: SortField; order?: SortOrder; limit?: number; offset?: number } = {}) => {
      const p = new URLSearchParams();
      if (opts.q) p.set('q', opts.q);
      if (opts.tag) p.set('tag', opts.tag);
      if (opts.titlePrefix) p.set('titlePrefix', 'true');
      if (opts.sort) p.set('sort', opts.sort);
      if (opts.order) p.set('order', opts.order);
      if (opts.limit != null) p.set('limit', String(opts.limit));
      if (opts.offset != null) p.set('offset', String(opts.offset));
      const qs = p.toString();
      return request<NoteList>('GET', `/notes${qs ? `?${qs}` : ''}`);
    },

    get: (slug: string) =>
      request<Note>('GET', `/notes/${slug}`, undefined, [400]),

    create: (body: CreateNoteRequest) =>
      request<Note>('POST', '/notes', body),

    update: (slug: string, body: UpdateNoteRequest, ifMatch?: string) =>
      request<Note>('PATCH', `/notes/${slug}`, body, [],
        ifMatch ? { 'If-Match': ifMatch } : undefined),

    delete: (slug: string) =>
      request<void>('DELETE', `/notes/${slug}`),

    importHtml: (html: string): Promise<Note> =>
      requestRaw<Note>('POST', '/import', html, 'text/html'),

    importMarkdown: (markdown: string): Promise<Note> =>
      requestRaw<Note>('POST', '/import', markdown, 'text/markdown'),

    // Fetch the server-rendered, standalone HTML document for a note (the same
    // artifact the Download HTML link produces, with internal images inlined).
    // Reused by the client-side print flow, which loads it into a hidden iframe
    // and invokes the browser's print dialog.
    exportHtml: async (slug: string): Promise<string> => {
      const res = await fetchWithRetry(`${BASE}/notes/${slug}/download-html`, { method: 'GET' });
      if (res.status === 401) { window.location.reload(); throw new Error('Unauthorized'); }
      if (res.status === 404) throw new NotFoundError();
      if (!res.ok) throw new Error(res.statusText);
      return res.text();
    },
  },

  artifacts: {
    create: (file: File): Promise<Artifact> =>
      requestBinary<Artifact>('POST', '/artifacts', file, file.type),

    // Fetch the raw bytes and content type of a stored artifact. Used by the
    // client-side HTML export to inline internal artifact images so a downloaded
    // document renders standalone. Resolves to null when the artifact is unknown
    // or unavailable, mirroring the server export's "leave the reference as-is"
    // behaviour rather than failing the whole export.
    get: async (sha256: string): Promise<{ blob: Blob; contentType: string } | null> => {
      const res = await fetchWithRetry(`${BASE}/artifacts/${sha256}`, { method: 'GET' });
      if (res.status === 401) { window.location.reload(); throw new Error('Unauthorized'); }
      if (!res.ok) return null;
      const blob = await res.blob();
      const contentType = (res.headers.get('Content-Type') ?? blob.type).split(';')[0].trim();
      return { blob, contentType };
    },
  },

  tags: {
    list: (): Promise<TagList> =>
      request<TagList>('GET', '/tags'),

    create: (body: CreateTagRequest): Promise<Tag> =>
      request<Tag>('POST', '/tags', body),

    delete: (slug: string): Promise<void> =>
      request<void>('DELETE', `/tags/${slug}`),
  },
};
