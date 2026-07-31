// Client-side preferences, persisted to localStorage. Stored values are
// untrusted (the user can edit localStorage), so getConfig() always re-validates
// against DEFAULTS rather than trusting the parsed JSON shape.

import type { SortField, SortOrder } from '../api/client.js';

export interface AppConfig {
  theme: 'light' | 'dark';
  pageSize: number;
  sortField: SortField;
  sortOrder: SortOrder;
  // Settings override for the MyMail integration; absent means "use the URL the
  // server derived from -public-url". See util/mymail.ts.
  mymailUrl?: string;
}

const STORAGE_KEY = 'mynotes-settings';

const DEFAULTS: AppConfig = {
  theme: 'light',
  pageSize: 50,
  sortField: 'updated',
  sortOrder: 'desc',
};

const VALID_THEMES = ['light', 'dark'] as const;
const VALID_SORT_FIELDS = ['updated', 'created', 'title'] as const;
const VALID_SORT_ORDERS = ['asc', 'desc'] as const;

// Absolute http(s) URL with no query, fragment, or character that could smuggle
// a second URL component past the concatenation in util/email.ts, which appends
// the API path to this base.
const MYMAIL_URL_RE = /^https?:\/\/[^\s"'<>\\?#]{1,500}$/;

function sanitize(parsed: unknown): AppConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULTS };
  }
  const p = parsed as Record<string, unknown>;

  const theme = VALID_THEMES.includes(p.theme as AppConfig['theme'])
    ? (p.theme as AppConfig['theme'])
    : DEFAULTS.theme;

  const rawSize = Number(p.pageSize);
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 200
    ? rawSize
    : DEFAULTS.pageSize;

  const sortField = VALID_SORT_FIELDS.includes(p.sortField as SortField)
    ? (p.sortField as SortField)
    : DEFAULTS.sortField;

  const sortOrder = VALID_SORT_ORDERS.includes(p.sortOrder as SortOrder)
    ? (p.sortOrder as SortOrder)
    : DEFAULTS.sortOrder;

  const mymailUrl = typeof p.mymailUrl === 'string' && MYMAIL_URL_RE.test(p.mymailUrl)
    ? p.mymailUrl
    : undefined;

  return { theme, pageSize, sortField, sortOrder, ...(mymailUrl !== undefined && { mymailUrl }) };
}

export function getConfig(): AppConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return sanitize(JSON.parse(stored));
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULTS };
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
