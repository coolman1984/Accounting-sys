/**
 * Budget arithmetic — pure functions, no database.
 *
 *  - spread():            an annual figure over the months, evenly or following a pattern.
 *  - flexibleVariances(): static budget → flexible budget → actual (the three-column analysis).
 *  - salesVariances():    sales price, volume, mix and quantity variances per item.
 *
 * Conventions: money in minor units; quantities × 1000 (like the rest of the system).
 * A variance is "favourable" when it raises profit: more revenue than planned, or less cost.
 */

/** Split `total` over `months` in proportion to `weights` (even when absent); the remainder goes to the last month. */
export function spread(total: number, months = 12, weights?: number[]): number[] {
  const w = weights && weights.length === months && weights.some((x) => x > 0) ? weights.map((x) => Math.max(x, 0)) : Array(months).fill(1);
  const sumW = w.reduce((s, x) => s + x, 0);
  const out = w.map((x) => Math.trunc((total * x) / sumW));
  out[months - 1] += total - out.reduce((s, x) => s + x, 0);
  return out;
}

/**
 * A new budget's months from 12 past months (already uplifted). Each budget month takes the same calendar
 * month from the source, so seasons stay aligned when the source starts mid-year. Source months that are
 * not complete yet are unknown, not zero: they get the average of the complete ones. `even` spreads the
 * resulting (annualised) total evenly.
 */
export function seedMonths(values: number[], sourceMonths: string[], complete: boolean[], budgetMonths: string[], pattern: 'seasonal' | 'even'): number[] {
  const known = values.filter((_, i) => complete[i]);
  if (known.length === 0) return Array(budgetMonths.length).fill(0);
  const avg = Math.round(known.reduce((s, v) => s + v, 0) / known.length);
  const filled = values.map((v, i) => (complete[i] ? v : avg));
  if (pattern === 'even') return spread(filled.reduce((s, v) => s + v, 0), budgetMonths.length);
  return budgetMonths.map((m) => {
    const i = sourceMonths.findIndex((x) => x.slice(5, 7) === m.slice(5, 7));
    return i < 0 ? avg : filled[i];
  });
}

export interface VarianceLineInput {
  accountId: number;
  type: 'income' | 'expense';
  /** Share of this line that moves with activity, basis points (revenue always flexes fully). */
  variableBp: number;
  budget: number;
  actual: number;
}

export interface VarianceLine extends VarianceLineInput {
  flexible: number;
  /** Actual vs flexible — spending / efficiency (positive = favourable). */
  flexibleVariance: number;
  /** Flexible vs static — caused by the level of activity alone (positive = favourable). */
  activityVariance: number;
  /** Actual vs static (positive = favourable). */
  totalVariance: number;
  /** Total variance as a share of the static budget; null when nothing was budgeted. */
  totalPct: number | null;
}

/** Profit effect sign: income above plan helps, cost above plan hurts. */
const effect = (type: 'income' | 'expense', actualMinusPlan: number) => (type === 'income' ? actualMinusPlan : -actualMinusPlan);

/**
 * Flexible budget based on sales activity (for companies that budget money, not units):
 * activity index = actual revenue ÷ budgeted revenue. Revenue flexes fully; each cost flexes by its
 * variable share. When nothing was budgeted as revenue the index is 1 (no flexing).
 */
export function flexibleVariances(lines: VarianceLineInput[]) {
  const budgetRevenue = lines.filter((l) => l.type === 'income').reduce((s, l) => s + l.budget, 0);
  const actualRevenue = lines.filter((l) => l.type === 'income').reduce((s, l) => s + l.actual, 0);
  const index = budgetRevenue > 0 ? actualRevenue / budgetRevenue : 1;
  const out: VarianceLine[] = lines.map((l) => {
    const share = l.type === 'income' ? 1 : Math.min(Math.max(l.variableBp, 0), 10000) / 10000;
    const flexible = Math.round(l.budget * (1 - share + share * index));
    return {
      ...l,
      flexible,
      flexibleVariance: effect(l.type, l.actual - flexible),
      activityVariance: effect(l.type, flexible - l.budget),
      totalVariance: effect(l.type, l.actual - l.budget),
      totalPct: l.budget !== 0 ? (l.actual - l.budget) / Math.abs(l.budget) : null,
    };
  });
  const profit = (k: 'budget' | 'flexible' | 'actual') => out.reduce((s, l) => s + (l.type === 'income' ? l[k] : -l[k]), 0);
  const totals = {
    staticProfit: profit('budget'),
    flexibleProfit: profit('flexible'),
    actualProfit: profit('actual'),
  };
  return {
    index: budgetRevenue > 0 ? index : null,
    lines: out,
    totals: {
      ...totals,
      /** Sales-activity (volume) variance on profit. */
      activityVariance: totals.flexibleProfit - totals.staticProfit,
      /** Flexible-budget variance on profit (prices, spending, efficiency). */
      flexibleVariance: totals.actualProfit - totals.flexibleProfit,
      totalVariance: totals.actualProfit - totals.staticProfit,
    },
  };
}

export interface SalesItemInput {
  itemId: number;
  /** Budget quantity × 1000, budget unit price and unit cost (minor units per unit). */
  budgetQty: number;
  budgetPrice: number;
  budgetCost: number;
  /** Actual quantity × 1000 and actual revenue (minor units, base currency). */
  actualQty: number;
  actualRevenue: number;
  /** Sold without a budget line (budget price taken from the item's list price or the actual price). */
  unbudgeted?: boolean;
}

/**
 * Sales variances on contribution (budget unit contribution = budget price − budget unit cost):
 *   price    = actual revenue − actual qty × budget price
 *   volume   = (actual qty − budget qty) × budget unit contribution
 *     mix      = (actual mix − budget mix) × total actual qty × budget unit contribution
 *     quantity = (total actual qty − total budget qty) × budget mix × budget unit contribution
 * Volume = mix + quantity. Mix needs a budgeted total quantity.
 */
export function salesVariances(items: SalesItemInput[]) {
  const q = (x: number) => x / 1000;
  const budgetTotal = items.reduce((s, i) => s + q(i.budgetQty), 0);
  const actualTotal = items.reduce((s, i) => s + q(i.actualQty), 0);
  const rows = items.map((i) => {
    const bq = q(i.budgetQty);
    const aq = q(i.actualQty);
    const ucm = i.budgetPrice - i.budgetCost;
    const price = Math.round(i.actualRevenue - aq * i.budgetPrice);
    const volume = Math.round((aq - bq) * ucm);
    const budgetMix = budgetTotal > 0 ? bq / budgetTotal : null;
    const actualMix = actualTotal > 0 ? aq / actualTotal : 0;
    const mix = budgetMix == null ? null : Math.round((actualMix - budgetMix) * actualTotal * ucm);
    const quantity = budgetMix == null ? null : Math.round((actualTotal - budgetTotal) * budgetMix * ucm);
    return {
      ...i,
      actualPrice: aq > 0 ? i.actualRevenue / aq : null,
      budgetMix,
      actualMix,
      priceVariance: price,
      volumeVariance: volume,
      mixVariance: mix,
      quantityVariance: quantity,
    };
  });
  const sum = (k: 'priceVariance' | 'volumeVariance' | 'mixVariance' | 'quantityVariance') => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  return {
    rows,
    totals: {
      budgetQty: budgetTotal,
      actualQty: actualTotal,
      priceVariance: sum('priceVariance'),
      volumeVariance: sum('volumeVariance'),
      mixVariance: budgetTotal > 0 ? sum('mixVariance') : null,
      quantityVariance: budgetTotal > 0 ? sum('quantityVariance') : null,
    },
  };
}
