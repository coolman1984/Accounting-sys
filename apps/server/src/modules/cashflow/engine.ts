/**
 * Cash forecast arithmetic — pure functions, no database.
 *
 *  - buckets():     the forecast periods (weeks or calendar months) from a start date.
 *  - occurrences(): the dates of a recurring planned item inside a window.
 *  - expectedDate(): when a customer invoice is likely to be paid, from the customer's habit.
 *  - forecast():    opening cash + dated flows → a running balance per period, lowest point, shortfalls.
 *
 * Money is in minor units of the company currency; inflows are positive, outflows negative.
 */
import { addDays, addMonths, daysBetween, endOfMonth } from '../../kernel/dates.js';

export type Granularity = 'week' | 'month';
export type Repeat = 'once' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export type FlowSource = 'receivables' | 'payables' | 'orders' | 'planned' | 'booked';

export interface Bucket {
  from: string;
  to: string;
}

/** `count` periods from `start`: weeks of 7 days, or calendar months (the first one starting at `start`). */
export function buckets(start: string, granularity: Granularity, count: number): Bucket[] {
  const out: Bucket[] = [];
  let from = start;
  for (let i = 0; i < count; i++) {
    const to = granularity === 'week' ? addDays(from, 6) : endOfMonth(from);
    out.push({ from, to });
    from = addDays(to, 1);
  }
  return out;
}

/** The same day of month `k` months after `date`, clamped to the month's last day (31 Jan → 28/29 Feb). */
export function sameDayMonthsLater(date: string, k: number): string {
  const first = addMonths(date, k);
  const last = endOfMonth(first);
  const day = Math.min(Number(date.slice(8, 10)), Number(last.slice(8, 10)));
  return first.slice(0, 8) + String(day).padStart(2, '0');
}

/** Dates on which a planned item falls between `from` and `to` (inclusive), never past its own end date. */
export function occurrences(item: { startDate: string; repeat: Repeat; endDate: string | null }, from: string, to: string): string[] {
  const out: string[] = [];
  const stop = item.endDate && item.endDate < to ? item.endDate : to;
  const step = { weekly: 0, monthly: 1, quarterly: 3, yearly: 12, once: 0 }[item.repeat];
  for (let k = 0; k < 2000; k++) {
    let d: string;
    if (item.repeat === 'once') {
      if (k > 0) break;
      d = item.startDate;
    } else if (item.repeat === 'weekly') d = addDays(item.startDate, 7 * k);
    else d = sameDayMonthsLater(item.startDate, step * k);
    if (d > stop) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/**
 * When an open invoice is likely to be collected: its due date plus the customer's usual delay,
 * never before `today`. An invoice already overdue by more than the usual delay is expected today.
 */
export function expectedDate(dueDate: string, delayDays: number, today: string): string {
  const d = addDays(dueDate, Math.max(0, Math.round(delayDays)));
  return d < today ? today : d;
}

/** Amount-weighted average days paid after the due date (early payments count as zero). */
export function averageDelay(payments: { dueDate: string; paidDate: string; amount: number }[]): number | null {
  let w = 0;
  let sum = 0;
  for (const p of payments) {
    if (p.amount <= 0) continue;
    w += p.amount;
    sum += p.amount * Math.max(0, daysBetween(p.dueDate, p.paidDate));
  }
  return w > 0 ? sum / w : null;
}

export interface Flow {
  date: string;
  amount: number;
  source: FlowSource;
  label: string;
  /** Document or plan reference for the drill-down. */
  ref?: string | null;
  /** The original due date when the flow was moved (overdue, customer habit). */
  dueDate?: string | null;
}

export interface ForecastBucket extends Bucket {
  opening: number;
  inflow: number;
  outflow: number;
  net: number;
  closing: number;
  bySource: Record<FlowSource, number>;
  flows: Flow[];
  belowMinimum: boolean;
}

/**
 * Running balance per period. Flows dated before the first period (overdue) fall into the first one;
 * flows after the last period are left out and returned as `beyond`.
 */
export function forecast(opening: number, periods: Bucket[], flows: Flow[], minCash: number) {
  const empty = (): Record<FlowSource, number> => ({ receivables: 0, payables: 0, orders: 0, planned: 0, booked: 0 });
  const out: ForecastBucket[] = periods.map((p) => ({ ...p, opening: 0, inflow: 0, outflow: 0, net: 0, closing: 0, bySource: empty(), flows: [], belowMinimum: false }));
  let beyond = 0;
  const last = periods.at(-1)?.to ?? '';
  for (const f of flows) {
    if (f.amount === 0) continue;
    if (f.date > last) {
      beyond += f.amount;
      continue;
    }
    const b = out.find((x) => f.date <= x.to) ?? out[0];
    if (!b) continue;
    b.flows.push(f);
    b.bySource[f.source] += f.amount;
    if (f.amount > 0) b.inflow += f.amount;
    else b.outflow -= f.amount;
  }
  let bal = opening;
  let lowest: { index: number; balance: number } | null = null;
  let firstShortfall: number | null = null;
  out.forEach((b, i) => {
    b.flows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    b.opening = bal;
    b.net = b.inflow - b.outflow;
    bal += b.net;
    b.closing = bal;
    b.belowMinimum = b.closing < minCash;
    if (b.belowMinimum && firstShortfall == null) firstShortfall = i;
    if (!lowest || b.closing < lowest.balance) lowest = { index: i, balance: b.closing };
  });
  return {
    opening,
    closing: bal,
    buckets: out,
    lowest,
    firstShortfall,
    /** Largest amount needed to stay at the minimum (0 when never below it). */
    fundingNeed: out.reduce((m, b) => Math.max(m, minCash - b.closing), 0),
    beyond,
  };
}
