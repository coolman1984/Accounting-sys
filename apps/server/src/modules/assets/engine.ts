/**
 * Fixed-asset arithmetic (IAS 16) — pure functions, no database.
 *
 *  - schedule():  the monthly depreciation of one asset over its remaining useful life.
 *  - disposal():  gain or loss when an asset leaves the books.
 *
 * Money in minor units. Depreciation is charged for whole months: from the month the asset is
 * available for use through the month it is disposed of. Never below the residual value.
 */

export type Method = 'straight_line' | 'declining';

export interface AssetBasis {
  cost: number;
  residual: number;
  /** Useful life in months. */
  lifeMonths: number;
  method: Method;
  /** Declining balance: yearly rate in basis points (default: double the straight-line rate). */
  rateBp?: number | null;
  /** First month of depreciation, as YYYY-MM. */
  startMonth: string;
  /** Depreciation already charged before this system (an asset brought in mid-life). */
  openingAccumulated?: number;
  /** Months of life already used before this system. */
  openingMonths?: number;
}

export interface ScheduleRow {
  month: string;
  amount: number;
  accumulated: number;
  bookValue: number;
}

/** YYYY-MM plus `n` months. */
export function addMonth(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

/** Months from `a` to `b` (b − a). */
export const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/** Double the straight-line rate, in basis points per year. */
export const defaultDecliningRate = (lifeMonths: number) => (lifeMonths > 0 ? Math.round((2 * 12 * 10000) / lifeMonths) : 0);

/**
 * The monthly schedule over what is left of the useful life.
 * Straight line: the depreciable amount left, spread evenly (the last month takes the rounding).
 * Declining balance: book value × rate / 12, switching to straight line once that gives more,
 * and the last month brings the book value exactly to the residual value.
 */
export function schedule(a: AssetBasis): ScheduleRow[] {
  const opening = a.openingAccumulated ?? 0;
  const months = Math.max(0, a.lifeMonths - (a.openingMonths ?? 0));
  const depreciable = Math.max(0, a.cost - a.residual - opening);
  const rows: ScheduleRow[] = [];
  if (months === 0 || depreciable === 0) return rows;
  let accumulated = opening;
  let left = depreciable;
  const rate = (a.rateBp ?? defaultDecliningRate(a.lifeMonths)) / 10000;
  for (let i = 0; i < months; i++) {
    const remaining = months - i;
    let amount: number;
    if (i === months - 1) amount = left;
    else if (a.method === 'straight_line') amount = Math.round(depreciable / months);
    else {
      const book = a.cost - accumulated;
      const declining = Math.round((book * rate) / 12);
      const straight = Math.round(left / remaining);
      amount = Math.max(declining, straight);
    }
    amount = Math.min(Math.max(amount, 0), left);
    left -= amount;
    accumulated += amount;
    rows.push({ month: addMonth(a.startMonth, i), amount, accumulated, bookValue: a.cost - accumulated });
    if (left === 0) break;
  }
  return rows;
}

/** Gain (+) or loss (−) on disposal: proceeds − (cost − accumulated depreciation). */
export function disposal(cost: number, accumulated: number, proceeds: number) {
  const bookValue = cost - accumulated;
  return { bookValue, gain: proceeds - bookValue };
}
