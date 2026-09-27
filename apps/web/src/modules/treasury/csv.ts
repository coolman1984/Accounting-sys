import { normalizeDigits, parseDecimal } from '../../core/format';

/** Minimal CSV reader: quotes, escaped quotes, commas / semicolons / tabs, CRLF, a UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', '\t', ','].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()));
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()));
  return rows;
}

export type DateFormat = 'ymd' | 'dmy' | 'mdy';

/** "31/01/2026", "2026-01-31", "1-31-26" … → "2026-01-31" (null when it cannot be read). */
export function parseDate(input: string, format: DateFormat): string | null {
  const parts = normalizeDigits(input).trim().split(/[^\d]+/).filter(Boolean);
  if (parts.length < 3) return null;
  let [y, m, d] = format === 'ymd' ? parts : format === 'dmy' ? [parts[2], parts[1], parts[0]] : [parts[2], parts[0], parts[1]];
  if (y.length === 2) y = '20' + y;
  const iso = `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const dt = new Date(iso + 'T00:00:00Z');
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Guess the date order from the first values: a first part above 12 means day-first, a 4-digit first part means year-first. */
export function guessDateFormat(samples: string[]): DateFormat {
  for (const s of samples) {
    const p = normalizeDigits(s).split(/[^\d]+/).filter(Boolean);
    if (p[0]?.length === 4) return 'ymd';
    if (Number(p[0]) > 12) return 'dmy';
    if (Number(p[1]) > 12) return 'mdy';
  }
  return 'dmy';
}

export interface Mapping {
  header: boolean;
  date: number;
  description: number;
  reference: number | null;
  /** One signed amount column, or separate money-in / money-out columns. */
  amount: number | null;
  moneyIn: number | null;
  moneyOut: number | null;
  dateFormat: DateFormat;
}

/** Guess the columns from header names in English or Arabic. */
export function guessMapping(rows: string[][]): Mapping {
  const head = (rows[0] ?? []).map((h) => h.toLowerCase());
  const find = (...words: string[]) => {
    // Short words ("in", "out") must stand alone, or "description" would count as money in.
    const hit = (h: string, w: string) => (w.length <= 3 ? new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(h) : h.includes(w));
    const i = head.findIndex((h) => words.some((w) => hit(h, w)));
    return i >= 0 ? i : null;
  };
  const header = head.some((h) => /[a-z؀-ۿ]/.test(h) && !/^\d/.test(h));
  const date = find('date', 'تاريخ') ?? 0;
  const description = find('desc', 'detail', 'narr', 'particular', 'بيان', 'وصف', 'تفاصيل') ?? 1;
  const reference = find('ref', 'reference', 'cheque', 'check', 'مرجع', 'شيك');
  const moneyIn = find('credit', 'deposit', 'in', 'دائن', 'إيداع', 'وارد');
  const moneyOut = find('debit', 'withdraw', 'out', 'مدين', 'سحب', 'صادر');
  const amount = moneyIn != null && moneyOut != null && moneyIn !== moneyOut ? null : find('amount', 'value', 'مبلغ', 'قيمة') ?? 2;
  const body = header ? rows.slice(1) : rows;
  return {
    header,
    date,
    description,
    reference,
    amount,
    moneyIn: amount == null ? moneyIn : null,
    moneyOut: amount == null ? moneyOut : null,
    dateFormat: guessDateFormat(body.slice(0, 20).map((r) => r[date] ?? '')),
  };
}

export interface ParsedLine {
  date: string;
  description: string;
  reference: string | null;
  amount: number;
}

/** Apply the mapping; rows that cannot be read are returned with their row number so the user sees why. */
export function toLines(rows: string[][], m: Mapping, scale: number): { lines: ParsedLine[]; errors: number[] } {
  const lines: ParsedLine[] = [];
  const errors: number[] = [];
  (m.header ? rows.slice(1) : rows).forEach((r, i) => {
    const date = parseDate(r[m.date] ?? '', m.dateFormat);
    const num = (c: number | null) => (c == null || !r[c] ? 0 : parseDecimal(r[c], scale));
    const amount = m.amount != null ? num(m.amount) : (() => {
      const a = num(m.moneyIn);
      const b = num(m.moneyOut);
      return a == null || b == null ? null : Math.abs(a) - Math.abs(b);
    })();
    if (!date || amount == null) return errors.push(i + (m.header ? 2 : 1));
    if (amount === 0) return; // balance-only rows
    lines.push({ date, description: r[m.description] || '—', reference: m.reference != null ? r[m.reference] || null : null, amount });
  });
  return { lines, errors };
}
