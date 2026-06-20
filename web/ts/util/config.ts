// Client-side preferences, persisted to localStorage. Stored values are
// untrusted (the user can edit localStorage), so getConfig() always re-validates
// against DEFAULTS rather than trusting the parsed JSON shape.

export interface AppConfig {
  theme: 'light' | 'dark';
  pageSize: number;
}

const STORAGE_KEY = 'go-web-template-settings';

const DEFAULTS: AppConfig = {
  theme: 'light',
  pageSize: 50,
};

const VALID_THEMES = ['light', 'dark'] as const;

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

  return { theme, pageSize };
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
