import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'mizan.theme';

interface ThemeValue {
  pref: ThemePref;
  resolved: 'light' | 'dark';
  setPref(p: ThemePref): void;
  toggle(): void;
}

const ThemeContext = createContext<ThemeValue | null>(null);
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  });
  const [systemDark, setSystemDark] = useState(() => media().matches);

  useEffect(() => {
    const m = media();
    const on = () => setSystemDark(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);

  const resolved: 'light' | 'dark' = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
  }, [pref, resolved]);

  const value = useMemo<ThemeValue>(
    () => ({ pref, resolved, setPref, toggle: () => setPref(resolved === 'dark' ? 'light' : 'dark') }),
    [pref, resolved],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
