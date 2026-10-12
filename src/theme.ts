export type Theme = 'light' | 'dark';

const KEY = 'paircut.theme';

/** The saved choice, or the system setting until the user picks one. */
export function initialTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
}
