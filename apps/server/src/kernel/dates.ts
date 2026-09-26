/** Dates are stored as ISO `YYYY-MM-DD` strings (no time zone surprises). */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function today(): string {
  const d = new Date();
  return toIso(d);
}

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isValidDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

export function startOfMonth(iso: string): string {
  return iso.slice(0, 8) + '01';
}

export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, 0));
  return dt.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const [y, m] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, 1));
  return dt.toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}
