/**
 * Recurring schedules — pure date arithmetic.
 *
 * A template repeats every `interval` weeks, months, quarters or years from its first date. Monthly
 * schedules keep the day of the first date and clamp to the month's end (31 Jan → 28 Feb → 31 Mar).
 */
export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The n-th occurrence (0 = the first date). */
export function occurrence(first: string, frequency: Frequency, interval: number, n: number): string {
  const step = Math.max(1, interval) * n;
  if (frequency === 'weekly') {
    const d = new Date(`${first}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7 * step);
    return d.toISOString().slice(0, 10);
  }
  const months = step * (frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12);
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7)) - 1 + months;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const day = Math.min(Number(first.slice(8, 10)), daysIn(yy, mm + 1));
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Placeholders in memos and notes: {month} → 2026-10, {year} → 2026, {date} → 2026-10-01. */
export function fillPlaceholders(text: string | null, date: string): string | null {
  if (!text) return text;
  return text.replaceAll('{month}', date.slice(0, 7)).replaceAll('{year}', date.slice(0, 4)).replaceAll('{date}', date);
}

/** Dates still due up to `upTo`, starting at occurrence `done`, within the end date and count. */
export function dueDates(t: { first: string; frequency: Frequency; interval: number; done: number; endDate: string | null; maxCount: number | null }, upTo: string, limit = 60): string[] {
  const out: string[] = [];
  for (let n = t.done; out.length < limit; n++) {
    if (t.maxCount != null && n >= t.maxCount) break;
    const d = occurrence(t.first, t.frequency, t.interval, n);
    if (d > upTo || (t.endDate && d > t.endDate)) break;
    out.push(d);
  }
  return out;
}
