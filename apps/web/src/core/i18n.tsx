import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import en, { type Dictionary } from './locales/en';
import ar from './locales/ar';

export type Locale = 'en' | 'ar';
const dictionaries: Record<Locale, Dictionary> = { en, ar };
const STORAGE_KEY = 'mizan.locale';

type Vars = Record<string, string | number | null | undefined>;

interface I18nValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  setLocale(l: Locale): void;
  /** Translate a dotted key, e.g. t('nav.dashboard'). Missing keys fall back to English, then to the key. */
  t(key: string, vars?: Vars): string;
  /** Whether a key exists (used for translating server error codes). */
  has(key: string): boolean;
  /** Pick the right language from a bilingual record. */
  pick(en: string | null | undefined, ar: string | null | undefined): string;
}

const I18nContext = createContext<I18nValue | null>(null);

function lookup(dict: unknown, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as object)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

function readStored(): Locale {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ar' ? 'ar' : 'en';
  } catch {
    return 'en';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStored);

  useEffect(() => {
    const html = document.documentElement;
    html.lang = locale;
    html.dir = locale === 'ar' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* private mode */
    }
  }, [locale]);

  const setLocale = useCallback((l: Locale) => setLocaleState(l), []);

  const value = useMemo<I18nValue>(() => {
    const dict = dictionaries[locale];
    return {
      locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      setLocale,
      t: (key, vars) => interpolate(lookup(dict, key) ?? lookup(en, key) ?? key, vars),
      has: (key) => lookup(dict, key) !== undefined,
      pick: (e, a) => (locale === 'ar' ? a || e || '' : e || a || ''),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
