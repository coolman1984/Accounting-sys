/**
 * Number & date formatting. Money arrives from the server as integer minor
 * units and is formatted with pure string math — never floats.
 */
import type { Locale } from './i18n';

const intl = (locale: Locale) => (locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US');
const groupers = new Map<string, Intl.NumberFormat>();

function groupInt(digits: string, locale: Locale): string {
  const key = intl(locale);
  let f = groupers.get(key);
  if (!f) {
    f = new Intl.NumberFormat(key, { maximumFractionDigits: 0 });
    groupers.set(key, f);
  }
  // Safe: we only format the integer part, which is below 2^53.
  return f.format(Number(digits));
}

export interface MoneyOpts {
  /** Show negatives as (1,234.00) — accounting style. */
  parens?: boolean;
  /** Render zero as a dash. */
  dashZero?: boolean;
  /** Prefix a + sign for positives. */
  signed?: boolean;
}

export function formatMinor(v: number | null | undefined, scale: number, locale: Locale, o: MoneyOpts = {}): string {
  if (v == null) return '';
  if (v === 0 && o.dashZero) return '—';
  const neg = v < 0;
  const abs = String(Math.abs(v)).padStart(scale + 1, '0');
  const intPart = abs.slice(0, abs.length - scale) || '0';
  const frac = scale > 0 ? abs.slice(abs.length - scale) : '';
  const s = groupInt(intPart, locale) + (scale > 0 ? '.' + frac : '');
  if (neg) return o.parens ? `(${s})` : `-${s}`;
  return o.signed && v > 0 ? `+${s}` : s;
}

/** Arabic-Indic and Persian digits → ASCII, Arabic separators → ASCII. */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/[٬،]/g, ',');
}

/**
 * Parse user input like "1,234.5" into integer units at `scale` decimals.
 * Returns null for empty/invalid input. Excess decimals are rounded half-up.
 */
export function parseDecimal(input: string, scale: number): number | null {
  let s = normalizeDigits(input).trim().replace(/[,\s]/g, '');
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d*$/.test(s) || s === '.') return null;
  const [i = '', f = ''] = s.split('.');
  const padded = (f + '0'.repeat(scale + 1)).slice(0, scale + 1);
  let n = BigInt((i || '0') + padded.slice(0, scale));
  if (Number(padded[scale]) >= 5) n += 1n;
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const v = Number(n);
  return neg ? -v : v;
}

/** Integer units → plain editable string ("1234.50"). */
export function toEditable(v: number | null | undefined, scale: number): string {
  if (v == null) return '';
  const neg = v < 0;
  const abs = String(Math.abs(v)).padStart(scale + 1, '0');
  const s = scale > 0 ? `${abs.slice(0, -scale)}.${abs.slice(-scale)}` : abs;
  return neg ? '-' + s : s;
}

export const QTY_SCALE = 3;

export function formatQty(v: number, locale: Locale): string {
  const s = formatMinor(v, QTY_SCALE, locale);
  return s.replace(/\.?0+$/, '');
}

export function formatBp(bp: number): string {
  return (bp / 100).toString().replace(/\.0+$/, '') + '%';
}

const dateFmts = new Map<string, Intl.DateTimeFormat>();
export function formatDate(iso: string | null | undefined, locale: Locale, style: 'short' | 'long' = 'short'): string {
  if (!iso) return '';
  const key = locale + style;
  let f = dateFmts.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(intl(locale), {
      day: 'numeric',
      month: style === 'long' ? 'long' : 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    dateFmts.set(key, f);
  }
  return f.format(new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso));
}

export function formatDateTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(intl(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatMonth(ym: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intl(locale), { month: 'short', timeZone: 'UTC' }).format(new Date(ym + '-01T00:00:00Z'));
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
