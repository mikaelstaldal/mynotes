// Client-side preferences, persisted to localStorage. Stored values are
// untrusted (the user can edit localStorage), so getConfig() always re-validates
// against DEFAULTS rather than trusting the parsed JSON shape.

import type { SortField, SortOrder } from '../api/client.js';

export interface AppConfig {
  theme: 'light' | 'dark';
  pageSize: number;
  sortField: SortField;
  sortOrder: SortOrder;
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

  return { theme, pageSize, sortField, sortOrder };
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
