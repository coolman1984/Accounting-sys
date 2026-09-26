import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../core/theme';
import { useI18n } from '../core/i18n';

/** The Mizan mark: an "M" drawn as a graph — nodes joined by lines, like a balanced ledger. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 25V8l9 10 9-10v17" fill="none" stroke="var(--primary)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="7" cy="25" r="3" fill="var(--bg)" stroke="var(--primary)" strokeWidth="2.4" />
      <circle cx="25" cy="25" r="3" fill="var(--bg)" stroke="var(--primary)" strokeWidth="2.4" />
      <circle cx="16" cy="18" r="2.6" fill="var(--primary)" />
      <circle cx="7" cy="8" r="2.2" fill="var(--primary)" />
      <circle cx="25" cy="8" r="2.2" fill="var(--primary)" />
    </svg>
  );
}

export function Logo({ company }: { company?: string | null }) {
  const { t } = useI18n();
  return (
    <div className="row" style={{ gap: 10, minWidth: 0 }}>
      <LogoMark />
      <div style={{ minWidth: 0, lineHeight: 1.1 }}>
        <div className="brand-name">{t('app.name')}</div>
        {company && <div className="brand-company">{company}</div>}
      </div>
    </div>
  );
}

/** Sun / moon pill, as in the reference design. */
export function ThemeToggle() {
  const { resolved, setPref } = useTheme();
  const { t } = useI18n();
  return (
    <div className="theme-toggle" role="group">
      <button className="sun" aria-pressed={resolved === 'light'} onClick={() => setPref('light')} title={t('shell.themeLight')} aria-label={t('shell.themeLight')}>
        <Sun />
      </button>
      <button className="moon" aria-pressed={resolved === 'dark'} onClick={() => setPref('dark')} title={t('shell.themeDark')} aria-label={t('shell.themeDark')}>
        <Moon />
      </button>
    </div>
  );
}

export function LangToggle({ onChange }: { onChange?(l: 'en' | 'ar'): void }) {
  const { locale, setLocale } = useI18n();
  const next = locale === 'ar' ? 'en' : 'ar';
  return (
    <button
      className="btn btn-sm lang-btn"
      onClick={() => {
        setLocale(next);
        onChange?.(next);
      }}
      title={next === 'ar' ? 'العربية' : 'English'}
      style={{ fontFamily: next === 'ar' ? "'IBM Plex Sans Arabic', sans-serif" : undefined }}
    >
      {next === 'ar' ? 'ع' : 'EN'}
    </button>
  );
}

/**
 * Decorative "git graph" lines that frame the auth screens — colored rails
 * with rounded corners and node dots, straight from the reference design.
 */
export function DecorLines() {
  const lines = [
    { c: 'var(--line-purple)', d: 'M -20 60 H 150 Q 170 60 170 80 V 250', dot: [170, 250] },
    { c: 'var(--line-teal)', d: 'M -20 330 H 80 Q 100 330 100 350 V 430 Q 100 450 120 450 H 260', dot: [260, 450] },
    { c: 'var(--line-blue)', d: 'M -20 540 H 60 Q 80 540 80 520 V 470', dot: [80, 470] },
    { c: 'var(--line-amber)', d: 'M 1460 110 H 1320 Q 1300 110 1300 130 V 300', dot: [1300, 300] },
    { c: 'var(--line-pink)', d: 'M 1460 250 H 1400 Q 1380 250 1380 270 V 470 Q 1380 490 1360 490 H 1180', dot: [1180, 490] },
    { c: 'var(--line-blue)', d: 'M 1460 380 H 1240 Q 1220 380 1220 400 V 600', dot: [1220, 600] },
    { c: 'var(--line-purple)', d: 'M 1250 -20 V 40 Q 1250 60 1270 60 H 1460', dot: [1250, 40] },
  ];
  return (
    <svg className="decor" viewBox="0 0 1440 800" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
      {lines.map((l, i) => (
        <g key={i}>
          <path d={l.d} stroke={l.c} />
          <circle cx={l.dot[0]} cy={l.dot[1]} r="4.5" fill={l.c} />
        </g>
      ))}
    </svg>
  );
}

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
