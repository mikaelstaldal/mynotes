// Light/dark theme: the single source of truth for the app's runtime theme.
// The chosen value is persisted in localStorage (via config.ts) and applied to
// the document root as `data-theme`, which app.css and the Mermaid renderer both
// read. Light is the default (see config.ts DEFAULTS).

import { getConfig, saveConfig } from './config.js';

export type Theme = 'light' | 'dark';

// Fired on `document` whenever the theme changes, so views that bake the theme
// into rendered output (Mermaid diagrams) can re-render. CSS-variable styling
// updates on its own the instant `data-theme` flips, so most of the UI needs no
// listener.
const THEME_EVENT = 'mynotes-themechange';

export function getTheme(): Theme {
  return getConfig().theme;
}

// Reflect a theme on the document root; app.css keys every colour off this.
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

// Persist, apply, and notify subscribers.
export function setTheme(theme: Theme): void {
  saveConfig({ ...getConfig(), theme });
  applyTheme(theme);
  document.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
}

// Flip between light and dark, returning the new theme.
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

// Subscribe to theme changes; returns an unsubscribe function.
export function onThemeChange(cb: (theme: Theme) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<Theme>).detail);
  document.addEventListener(THEME_EVENT, handler);
  return () => document.removeEventListener(THEME_EVENT, handler);
}
