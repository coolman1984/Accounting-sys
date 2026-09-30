import type { ModuleContext } from '../../kernel/modules.js';
import { fail } from '../../kernel/errors.js';
import { divRound } from '../../kernel/money.js';
import { endOfMonth } from '../../kernel/dates.js';
import { MONTH, monthPlus, type DemandRow, type SopInternal } from './service.js';

/**
 * The KPI pack (plan 10-MIZAN WP-M6) and the executive S&OP view, from what this module and the sales service already know.
 *
 * Forecast accuracy follows the usual definition: 1 − Σ|actual − plan| ÷ Σ actual over items, for one month, with a lag of
 * one month (the plan is the one agreed in the cycle of the month before, so it could still steer supply). Bias is
 * (Σ plan − Σ actual) ÷ Σ actual: positive means over-forecasting. Actual is the invoiced quantity net of credit notes.
 * A figure that cannot be measured (no plan, or no sales) is null: never zero and never "100 %".
 */

const bp = (part: number, whole: number): number | null => (whole > 0 ? Number(divRound(BigInt(Math.round(part)) * 10000n, BigInt(whole))) : null);

export function createKpi(ctx: ModuleContext, sop: SopInternal) {
  const { db, services } = ctx;

  /** The plan a month is measured against: the cycle of the month before; its approved version, else the newest version that was ever approved. */
  function lagOnePlan(month: string): { versionId: number; period: string; rows: DemandRow[] } | null {
    const period = monthPlus(month, -1);
    const v = db.get<{ id: number }>(
      `SELECT v.id FROM sop_versions v JOIN sop_cycles c ON c.id = v.cycle_id
       WHERE c.period = ? AND v.status IN ('approved', 'superseded') ORDER BY (v.status = 'approved') DESC, v.version_no DESC LIMIT 1`,
      [period],
    );
    return v ? { versionId: v.id, period, rows: sop.rows(v.id).filter((r) => r.month === month) } : null;
  }

  function forecast(month: string) {
    const plan = lagOnePlan(month);
    const actual = services.get('sales').invoicedQty(month, month);
    const actualBy = new Map<number, number>();
    for (const a of actual) actualBy.set(a.itemId, (actualBy.get(a.itemId) ?? 0) + a.qty);
    if (!plan) return { basis: null, accuracy_bp: null, bias_bp: null, plan_qty: null, actual_qty: [...actualBy.values()].reduce((s, q) => s + q, 0), items: [] as unknown[] };
    const items = new Set<number>([...plan.rows.map((r) => r.item_id), ...actualBy.keys()]);
    const planBy = new Map(plan.rows.map((r) => [r.item_id, r]));
    const rows = [...items].sort((a, b) => a - b).map((itemId) => {
      const p = planBy.get(itemId)?.qty ?? 0;
      const a = actualBy.get(itemId) ?? 0;
      const sku = services.get('catalog').item(itemId).sku;
      return { item_id: itemId, sku, plan_qty: p, actual_qty: a, error_qty: Math.abs(a - p), unit_price: planBy.get(itemId)?.unit_price ?? 0 };
    });
    const sumActual = rows.reduce((s, r) => s + r.actual_qty, 0);
    const sumPlan = rows.reduce((s, r) => s + r.plan_qty, 0);
    const sumError = rows.reduce((s, r) => s + r.error_qty, 0);
    const acc = bp(sumError, sumActual);
    return {
      basis: { period: plan.period, version_id: plan.versionId, lag_months: 1 },
      accuracy_bp: acc === null ? null : Math.max(0, 10000 - acc),
      bias_bp: sumActual > 0 ? Number(divRound(BigInt(sumPlan - sumActual) * 10000n, BigInt(sumActual))) : null,
      plan_qty: sumPlan,
      actual_qty: sumActual,
      items: rows,
    };
  }

  /** The KPI pack of one month (YYYY-MM). Money is in the base currency's minor units, quantities ×1000, ratios in basis points. */
  function pack(month: string) {
    if (!MONTH.test(month)) fail('validation', 'Invalid month (YYYY-MM)');
    const service = services.get('sales').serviceLevel(`${month}-01`, endOfMonth(`${month}-01`));
    const fc = forecast(month);
    const revenueGap = fc.items.length
      ? (fc.items as { plan_qty: number; actual_qty: number; unit_price: number }[]).reduce((s, r) => s + Number(divRound(BigInt(r.actual_qty - r.plan_qty) * BigInt(r.unit_price), 1000n)), 0)
      : null;
    return {
      month,
      service: { lines_measured: service.lines, otd_bp: service.lines ? service.otdBp : null, otif_bp: service.lines ? service.otifBp : null, fill_rate_bp: service.lines ? service.fillRateBp : null },
      forecast: { accuracy_bp: fc.accuracy_bp, bias_bp: fc.bias_bp, plan_qty: fc.plan_qty, actual_qty: fc.actual_qty, basis: fc.basis },
      // Sales above (positive) or below (negative) the plan, valued at the plan price of each item.
      revenue_vs_plan: revenueGap,
      items: fc.items,
      not_measured_here: ['inventory turns and days of cover', 'DSO / DIO / DPO', 'gross margin by model', 'supplier on-time delivery and PPV', 'production variances', 'payroll cost per set'],
    };
  }

  /**
   * The executive S&OP page for one cycle: demand against supply and budget per month in value, the revenue gap to the budget,
   * and the five items with the largest supply shortfall (value at the plan price), each with what limits its supply.
   */
  function executive(versionId: number) {
    const cmp = sop.comparison(versionId);
    const cells = cmp.rows.flatMap((r) => r.cells.map((c) => ({ ...c, item_id: r.item_id, sku: r.sku, name_en: r.name_en, name_ar: r.name_ar })));
    const short = cells.filter((c) => c.supply_known && c.gap_qty < 0).sort((a, b) => a.gap_value - b.gap_value || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
    const unknown = cells.filter((c) => !c.supply_known && c.demand_qty > 0).length;
    return {
      cycle: cmp.cycle,
      version: cmp.version,
      // the supply gap counts only where a supply plan exists: no plan is unknown, not a shortfall of everything
      months: cmp.totals.map((t) => ({ month: t.month, demand_value: t.demand_value, budget_value: t.budget_value, revenue_gap_value: t.budget_gap_value, supply_gap_value: cells.filter((c) => c.month === t.month && c.supply_known).reduce((s, c) => s + c.gap_value, 0) })),
      totals: {
        demand_value: cmp.totals.reduce((s, t) => s + t.demand_value, 0),
        budget_value: cmp.totals.reduce((s, t) => s + t.budget_value, 0),
        revenue_gap_value: cmp.totals.reduce((s, t) => s + t.budget_gap_value, 0),
        supply_gap_value: short.reduce((s, c) => s + c.gap_value, 0),
      },
      top_constraints: short.slice(0, 5).map((c) => ({ item_id: c.item_id, sku: c.sku, name_en: c.name_en, name_ar: c.name_ar, month: c.month, demand_qty: c.demand_qty, supply_qty: c.supply_qty, gap_qty: c.gap_qty, gap_value: c.gap_value, constraint: c.constraint })),
      // Demand with no supply plan at all is not "short": it is unknown, and it is said so.
      demand_without_supply_plan: unknown,
    };
  }

  return { pack, executive, forecast };
}

export type KpiService = ReturnType<typeof createKpi>;
