/**
 * Manufacturing cost arithmetic — pure functions, no database.
 *
 *  - standardCost():       a bill of materials rolled up into the standard cost of a batch and of one unit.
 *  - orderVariances():     one production order against the standard allowed for what it actually produced.
 *  - overheadVariances():  the period's overhead: applied vs actual, spending / efficiency / volume.
 *
 * Conventions: money in minor units; quantities and hours × 1000; a unit cost is per one unit (1000 qty);
 * rates are per labour hour. A variance is positive when favourable (it lowers cost).
 */

export interface StdComponent {
  itemId: number;
  /** Quantity per batch (× 1000) before scrap. */
  qty: number;
  /** Expected scrap on top of `qty`, basis points. */
  scrapBp: number;
  /** Standard cost of one unit. */
  stdCost: number;
}

export interface Standard {
  /** Units a batch produces (× 1000). */
  outputQty: number;
  components: StdComponent[];
  /** Labour hours per batch (× 1000). */
  labourHours: number;
  labourRate: number;
  varOverheadRate: number;
  fixedOverheadRate: number;
}

const r = (n: number) => Math.round(n);

/** How many months `from`..`to` covers, counting part months by their days (1 Mar – 31 Mar = 1). */
export function monthFraction(from: string, to: string): number {
  let total = 0;
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (let guard = 0; guard < 1200; guard++) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    if (first > to) break;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${first.slice(0, 8)}${String(days).padStart(2, '0')}`;
    const a = from > first ? Number(from.slice(8, 10)) : 1;
    const b = to < last ? Number(to.slice(8, 10)) : days;
    if (b >= a) total += (b - a + 1) / days;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return total;
}

/** Standard quantity of a component for one batch, scrap included. */
export const grossQty = (c: StdComponent) => r((c.qty * (10000 + c.scrapBp)) / 10000);

/** Standard cost of one batch, by element, and of one unit of output. */
export function standardCost(s: Standard) {
  const materials = s.components.reduce((a, c) => a + (grossQty(c) * c.stdCost) / 1000, 0);
  const labour = (s.labourHours * s.labourRate) / 1000;
  const varOverhead = (s.labourHours * s.varOverheadRate) / 1000;
  const fixedOverhead = (s.labourHours * s.fixedOverheadRate) / 1000;
  const batch = { materials: r(materials), labour: r(labour), varOverhead: r(varOverhead), fixedOverhead: r(fixedOverhead), total: 0 };
  batch.total = batch.materials + batch.labour + batch.varOverhead + batch.fixedOverhead;
  const per = (v: number) => (s.outputQty > 0 ? r((v * 1000) / s.outputQty) : 0);
  const unit = { materials: per(materials), labour: per(labour), varOverhead: per(varOverhead), fixedOverhead: per(fixedOverhead), total: 0 };
  unit.total = per(materials + labour + varOverhead + fixedOverhead);
  return { batch, unit };
}

/** What the standard allows for `output` (× 1000) actually produced. */
export function allowed(s: Standard, output: number) {
  const k = s.outputQty > 0 ? output / s.outputQty : 0;
  return {
    components: s.components.map((c) => ({ itemId: c.itemId, qty: r(grossQty(c) * k) })),
    hours: r(s.labourHours * k),
  };
}

export interface ActualLine {
  itemId: number;
  /** Quantity actually used (× 1000). */
  qty: number;
  /** What it actually cost (from stock, moving average). */
  cost: number;
}

/**
 * Order variances (positive = favourable):
 *   material price = AQ × SP − actual cost      usage      = (SQ − AQ) × SP
 *   labour rate    = AH × SR − actual labour     efficiency = (SH − AH) × SR
 *   variable overhead efficiency = (SH − AH) × variable rate
 * Components used that are not in the standard have SQ = 0 and their own actual price as standard.
 */
export function orderVariances(s: Standard, output: number, lines: ActualLine[], actualHours: number, actualLabour: number) {
  const allow = allowed(s, output);
  const std = new Map(s.components.map((c) => [c.itemId, c]));
  const ids = [...new Set([...s.components.map((c) => c.itemId), ...lines.map((l) => l.itemId)])];
  const materials = ids.map((itemId) => {
    const c = std.get(itemId);
    const act = lines.filter((l) => l.itemId === itemId);
    const aq = act.reduce((a, l) => a + l.qty, 0);
    const cost = act.reduce((a, l) => a + l.cost, 0);
    const sq = allow.components.find((x) => x.itemId === itemId)?.qty ?? 0;
    const sp = c ? c.stdCost : aq > 0 ? (cost * 1000) / aq : 0;
    return {
      itemId,
      standardQty: sq,
      actualQty: aq,
      standardPrice: r(sp),
      actualCost: cost,
      standardCost: r((sq * sp) / 1000),
      price: r((aq * sp) / 1000 - cost),
      usage: r(((sq - aq) * sp) / 1000),
      unplanned: !c,
    };
  });
  const sh = allow.hours;
  const labour = {
    standardHours: sh,
    actualHours,
    standardCost: r((sh * s.labourRate) / 1000),
    actualCost: actualLabour,
    rate: r((actualHours * s.labourRate) / 1000 - actualLabour),
    efficiency: r(((sh - actualHours) * s.labourRate) / 1000),
  };
  const overhead = {
    appliedVariable: r((actualHours * s.varOverheadRate) / 1000),
    appliedFixed: r((actualHours * s.fixedOverheadRate) / 1000),
    standardVariable: r((sh * s.varOverheadRate) / 1000),
    standardFixed: r((sh * s.fixedOverheadRate) / 1000),
    varEfficiency: r(((sh - actualHours) * s.varOverheadRate) / 1000),
  };
  const sum = (k: 'price' | 'usage') => materials.reduce((a, m) => a + m[k], 0);
  const standardTotal = materials.reduce((a, m) => a + m.standardCost, 0) + labour.standardCost + overhead.standardVariable + overhead.standardFixed;
  const actualTotal = materials.reduce((a, m) => a + m.actualCost, 0) + actualLabour + overhead.appliedVariable + overhead.appliedFixed;
  return {
    materials,
    labour,
    overhead,
    totals: {
      standard: standardTotal,
      actual: actualTotal,
      materialPrice: sum('price'),
      materialUsage: sum('usage'),
      labourRate: labour.rate,
      labourEfficiency: labour.efficiency,
      varOverheadEfficiency: overhead.varEfficiency,
      /** Fixed overhead applied on actual rather than standard hours. */
      fixedOverheadEfficiency: overhead.standardFixed - overhead.appliedFixed,
      total: standardTotal - actualTotal,
    },
  };
}

/**
 * The period's overhead (positive = favourable):
 *   variable spending  = AH × VR − actual variable overhead      efficiency = (SH − AH) × VR
 *   fixed spending     = budgeted fixed − actual fixed           volume     = SH × FR − budgeted fixed
 *   under/over-absorbed = overhead applied to products − actual overhead
 */
export function overheadVariances(p: {
  actualHours: number;
  standardHours: number;
  appliedVariable: number;
  appliedFixed: number;
  standardVariable: number;
  standardFixed: number;
  actualVariable: number;
  actualFixed: number;
  budgetedFixed: number;
}) {
  return {
    varSpending: p.appliedVariable - p.actualVariable,
    varEfficiency: p.standardVariable - p.appliedVariable,
    fixedSpending: p.budgetedFixed - p.actualFixed,
    fixedVolume: p.standardFixed - p.budgetedFixed,
    absorbed: p.appliedVariable + p.appliedFixed - (p.actualVariable + p.actualFixed),
  };
}
