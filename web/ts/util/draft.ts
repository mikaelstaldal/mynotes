// Local-storage persistence of an in-progress note edit, so unsaved work can be
// restored if the browser is closed before the note is submitted to the backend.
//
// A draft is written periodically while editing (and once right before submit)
// and is only cleared once the change has been successfully saved. Stored values
// are untrusted (the user can edit localStorage), so loadDraft() re-validates the
// parsed shape rather than trusting it.

import type { Tag } from '../api/client.js';

export interface Draft {
  title: string;
  content: string;
  tags: Tag[];
  slugOverride?: string;   // new-note only: explicit slug override, if any
  savedAt: string;         // ISO-8601 timestamp of the last write
}

const PREFIX = 'mynotes-draft:';

// Existing notes key by their (stable) slug; a brand-new note has no slug yet, so
// it shares the single 'new' bucket.
function keyFor(slug: string | undefined): string {
  return PREFIX + (slug ?? 'new');
}

function sanitizeTags(raw: unknown): Tag[] {
  if (!Array.isArray(raw)) return [];
  const tags: Tag[] = [];
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) continue;
    const o = t as Record<string, unknown>;
    if (typeof o.slug === 'string' && typeof o.name === 'string') {
      tags.push({ slug: o.slug, name: o.name });
    }
  }
  return tags;
}

function sanitize(parsed: unknown): Draft | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.content !== 'string') return null;
  return {
    title: typeof p.title === 'string' ? p.title : '',
    content: p.content,
    tags: sanitizeTags(p.tags),
    slugOverride: typeof p.slugOverride === 'string' ? p.slugOverride : undefined,
    savedAt: typeof p.savedAt === 'string' ? p.savedAt : '',
  };
}

export function saveDraft(slug: string | undefined, draft: Draft): void {
  try {
    localStorage.setItem(keyFor(slug), JSON.stringify(draft));
  } catch {
    // Storage full or unavailable — persistence is best-effort.
  }
}

export function loadDraft(slug: string | undefined): Draft | null {
  try {
    const raw = localStorage.getItem(keyFor(slug));
    if (!raw) return null;
    return sanitize(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearDraft(slug: string | undefined): void {
  try {
    localStorage.removeItem(keyFor(slug));
  } catch {
    // ignore
  }
}
