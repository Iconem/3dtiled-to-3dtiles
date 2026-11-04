/**
 * System, light or dark. "System" follows the OS while the app is open. The choice is remembered
 * under a key the inline script in index.html also reads, so the first paint already has it.
 */
import { useCallback, useEffect, useState } from 'react';

const THEME_KEY = '3dtiled-desktop-theme';
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

const prefersLight = matchMedia('(prefers-color-scheme: light)');

const stored = (): Theme => {
  const v = localStorage.getItem(THEME_KEY) ?? '';
  return (THEMES as readonly string[]).includes(v) ? (v as Theme) : 'system';
};

const apply = (theme: Theme) => {
  document.documentElement.dataset['theme'] = theme === 'light' || (theme === 'system' && prefersLight.matches) ? 'light' : 'dark';
};

export const nextTheme = (theme: Theme): Theme => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => {
    apply(theme);
    const onChange = () => apply(theme);
    prefersLight.addEventListener('change', onChange);
    return () => prefersLight.removeEventListener('change', onChange);
  }, [theme]);
  const cycle = useCallback(() => {
    setTheme((t) => {
      const n = nextTheme(t);
      localStorage.setItem(THEME_KEY, n);
      return n;
    });
  }, []);
  return [theme, cycle];
}
