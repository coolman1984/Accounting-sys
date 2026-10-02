import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { addMonths, nowIso } from '../../kernel/dates.js';
import { divRound } from '../../kernel/money.js';
import { DEMAND_PLAN_V1 } from './eco.js';
import type {} from '../../contracts/sales.js';
import type {} from '../../contracts/pricing.js';
import type {} from '../../contracts/budget.js';
import type { SopApprovedPlan, SopService, SopSupplyInput } from '../../contracts/sop.js';

export interface Cycle {
  id: number;
  period: string;
  name: string;
  start_month: string;
  months: number;
  notes: string | null;
  created_at: string;
}

export interface Version {
  id: number;
  cycle_id: number;
  version_no: number;
  status: 'draft' | 'approved' | 'superseded';
  baseline_months: number;
  price_list_id: number | null;
  notes: string | null;
  created_at: string;
  approved_by: number | null;
  approved_at: string | null;
  superseded_at: string | null;
}

export interface DemandRow {
  id: number;
  version_id: number;
  item_id: number;
  month: string;
  baseline_qty: number;
  firm_qty: number;
  override_qty: number | null;
  qty: number;
  unit_price: number;
  amount: number;
}

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** YYYY-MM plus n months. */
export const monthPlus = (m: string, n: number) => addMonths(m + '-01', n).slice(0, 7);
const value = (qty: number, price: number) => Number(divRound(BigInt(qty) * BigInt(price), 1000n));

export type SopInternal = ReturnType<typeof createSop>;

/**
 * S&OP, kept simple (after SAP IBP S&OP): a monthly cycle, versions of the demand plan per item ×
 * month built from a statistical baseline (average invoiced quantity of the last N months), firm
 * open orders and manual overrides, valued at the price-list price; consensus approval as its own
 * duty; the demand compared with planned supply (and its constraint) and with the sales budget.
 */
export function createSop(ctx: ModuleContext) {
  const { db, services, events } = ctx;
  const audit = () => services.get('audit');
  const sales = () => services.get('sales');
  const catalog = () => services.get('catalog');

  const cycle = (id: number) => db.get<Cycle>('SELECT * FROM sop_cycles WHERE id = ?', [id]) ?? notFound('sop_cycle', id);
  const version = (id: number) => db.get<Version>('SELECT * FROM sop_versions WHERE id = ?', [id]) ?? notFound('sop_version', id);
  const rows = (versionId: number) => db.all<DemandRow>('SELECT * FROM sop_demand WHERE version_id = ? ORDER BY item_id, month', [versionId]);
  const monthsOf = (c: Cycle) => Array.from({ length: c.months }, (_, i) => monthPlus(c.start_month, i));
  const assertDraft = (v: Version) => {
    if (v.status !== 'draft') conflict('sop.not_draft', 'An approved plan is frozen — make a new version');
  };

  function createCycle(input: { period: string; startMonth?: string | null; months?: number; notes?: string | null }, userId: number | null): number {
    if (!MONTH.test(input.period)) fail('validation', 'Invalid period (YYYY-MM)');
    const start = input.startMonth ?? input.period;
    if (!MONTH.test(start)) fail('validation', 'Invalid start month (YYYY-MM)');
    if (db.get('SELECT 1 FROM sop_cycles WHERE period = ?', [input.period])) conflict('sop.duplicate_cycle', `S&OP ${input.period} already exists`, { period: input.period });
    return db.tx(() => {
      const id = db.insert('sop_cycles', { period: input.period, name: `S&OP ${input.period}`, start_month: start, months: input.months ?? 12, notes: input.notes ?? null, created_by: userId, created_at: nowIso() });
      audit().log({ userId, action: 'create', entity: 'sop_cycle', entityId: id, summary: input.period });
      return id;
    });
  }

  /** Price per base unit a plan is valued at: the chosen price list, else the item's sale price. */
  function priceOf(v: Pick<Version, 'price_list_id'>, itemId: number): number {
    if (v.price_list_id && services.has('pricing')) {
      const p = services.get('pricing').price(v.price_list_id, itemId, null);
      if (p != null) return p;
    }
    return catalog().item(itemId).sale_price;
  }

  /** Baseline per item: invoiced quantity of the N months before the cycle, averaged (flat over the horizon). */
  function baselines(c: Cycle, n: number): Map<number, number> {
    const hist = sales().invoicedQty(monthPlus(c.period, -n), monthPlus(c.period, -1));
    const total = new Map<number, number>();
    for (const h of hist) total.set(h.itemId, (total.get(h.itemId) ?? 0) + h.qty);
    return new Map([...total].map(([item, q]) => [item, Math.max(0, Number(divRound(BigInt(q), BigInt(n))))]));
  }

  /** Firm demand: open confirmed order lines by the month they are due (overdue ones count in the first month). */
  function firm(c: Cycle): Map<string, number> {
    const months = monthsOf(c);
    const last = months[months.length - 1];
    const out = new Map<string, number>();
    for (const d of sales().openDemand()) {
      let m = (d.promisedDate ?? d.requestedDate).slice(0, 7);
      if (m < c.start_month) m = c.start_month;
      if (m > last) continue;
      const k = `${d.itemId}:${m}`;
      out.set(k, (out.get(k) ?? 0) + d.openQty);
    }
    return out;
  }

  /** (Re)build the rows of a draft version, keeping its overrides. */
  function build(v: Version, keep: Map<string, number | null>) {
    const c = cycle(v.cycle_id);
    const months = monthsOf(c);
    const base = baselines(c, v.baseline_months);
    const fm = firm(c);
    const items = new Set<number>([...base.keys(), ...[...fm.keys()].map((k) => Number(k.split(':')[0])), ...[...keep.keys()].map((k) => Number(k.split(':')[0]))]);
    db.run('DELETE FROM sop_demand WHERE version_id = ?', [v.id]);
    for (const itemId of [...items].sort((a, b) => a - b)) {
      const price = priceOf(v, itemId);
      for (const m of months) {
        const k = `${itemId}:${m}`;
        const baseline = base.get(itemId) ?? 0;
        const firmQty = fm.get(k) ?? 0;
        const override = keep.get(k) ?? null;
        // Firm orders consume the forecast: the plan is at least what customers already ordered.
        const qty = override ?? Math.max(baseline, firmQty);
        db.insert('sop_demand', { version_id: v.id, item_id: itemId, month: m, baseline_qty: baseline, firm_qty: firmQty, override_qty: override, qty, unit_price: price, amount: value(qty, price) });
      }
    }
  }

  function createVersion(cycleId: number, input: { baselineMonths?: number; priceListId?: number | null; copyFrom?: number | null; notes?: string | null }, userId: number | null): number {
    const c = cycle(cycleId);
    let keep = new Map<string, number | null>();
    if (input.copyFrom) {
      const src = version(input.copyFrom);
      if (src.cycle_id !== c.id) fail('sop.other_cycle', 'Copy a version of the same cycle');
      keep = new Map(rows(src.id).filter((r) => r.override_qty != null).map((r) => [`${r.item_id}:${r.month}`, r.override_qty]));
    }
    return db.tx(() => {
      const no = db.get<{ n: number }>('SELECT COALESCE(MAX(version_no), 0) + 1 n FROM sop_versions WHERE cycle_id = ?', [c.id])!.n;
      const id = db.insert('sop_versions', {
        cycle_id: c.id,
        version_no: no,
        status: 'draft',
        baseline_months: input.baselineMonths ?? 3,
        price_list_id: input.priceListId ?? null,
        notes: input.notes ?? null,
        created_by: userId,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      build(version(id), keep);
      audit().log({ userId, action: 'create', entity: 'sop_version', entityId: id, summary: `${c.name} v${no}` });
      return id;
    });
  }

  function refresh(versionId: number, userId: number | null) {
    const v = version(versionId);
    assertDraft(v);
    db.tx(() => {
      build(v, new Map(rows(v.id).filter((r) => r.override_qty != null).map((r) => [`${r.item_id}:${r.month}`, r.override_qty])));
      db.run('UPDATE sop_versions SET updated_at = ? WHERE id = ?', [nowIso(), v.id]);
      audit().log({ userId, action: 'refresh', entity: 'sop_version', entityId: v.id });
    });
  }

  /** Manual overrides (null clears one); items not in the plan yet are added. */
  function setOverrides(versionId: number, lines: { itemId: number; month: string; qty: number | null }[], userId: number | null) {
    const v = version(versionId);
    assertDraft(v);
    const c = cycle(v.cycle_id);
    const months = new Set(monthsOf(c));
    db.tx(() => {
      for (const l of lines) {
        if (!months.has(l.month)) fail('sop.month_outside', `${l.month} is outside the cycle's horizon`, { month: l.month });
        catalog().item(l.itemId);
        const cur = db.get<DemandRow>('SELECT * FROM sop_demand WHERE version_id = ? AND item_id = ? AND month = ?', [v.id, l.itemId, l.month]);
        if (!cur) {
          // A new item: a full row set across the horizon, then the override.
          const price = priceOf(v, l.itemId);
          for (const m of months) db.insert('sop_demand', { version_id: v.id, item_id: l.itemId, month: m, baseline_qty: 0, firm_qty: 0, override_qty: null, qty: 0, unit_price: price, amount: 0 });
        }
        const r = db.get<DemandRow>('SELECT * FROM sop_demand WHERE version_id = ? AND item_id = ? AND month = ?', [v.id, l.itemId, l.month])!;
        const qty = l.qty ?? Math.max(r.baseline_qty, r.firm_qty);
        db.run('UPDATE sop_demand SET override_qty = ?, qty = ?, amount = ? WHERE id = ?', [l.qty, qty, value(qty, r.unit_price), r.id]);
      }
      db.run('UPDATE sop_versions SET updated_at = ? WHERE id = ?', [nowIso(), v.id]);
      audit().log({ userId, action: 'update', entity: 'sop_version', entityId: v.id, summary: `${lines.length} overrides` });
    });
  }

  /** Consensus: the version becomes the cycle's plan; the one approved before is superseded. */
  function approve(versionId: number, userId: number | null) {
    const v = version(versionId);
    assertDraft(v);
    if (!rows(v.id).length) fail('sop.empty', 'The plan has no lines');
    db.tx(() => {
      db.run(`UPDATE sop_versions SET status = 'superseded', superseded_at = ? WHERE cycle_id = ? AND status = 'approved'`, [nowIso(), v.cycle_id]);
      db.run(`UPDATE sop_versions SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`, [userId, nowIso(), nowIso(), v.id]);
      audit().log({ userId, action: 'approve', entity: 'sop_version', entityId: v.id, summary: `v${v.version_no}` });
      events.emit('sop.plan.approved', { versionId: v.id, cycleId: v.cycle_id, userId });
      if (services.has('eco')) {
        const eco = services.get('eco');
        for (const s of db.all<{ id: number }>("SELECT id FROM sop_versions WHERE cycle_id = ? AND status IN ('approved', 'superseded')", [v.cycle_id])) eco.changed(DEMAND_PLAN_V1, s.id);
      }
    });
  }

  function removeVersion(versionId: number, userId: number | null) {
    const v = version(versionId);
    assertDraft(v);
    db.tx(() => {
      db.run('DELETE FROM sop_versions WHERE id = ?', [v.id]);
      audit().log({ userId, action: 'delete', entity: 'sop_version', entityId: v.id });
    });
  }

  /**
   * Demand vs supply vs budget per item × month: supply gap = planned supply − demand (negative = short),
   * valued at the plan price; budget gap = demand − budget (quantity and money).
   */
  function comparison(versionId: number) {
    const v = version(versionId);
    const c = cycle(v.cycle_id);
    const months = monthsOf(c);
    const demand = rows(v.id);
    const supply = new Map(
      db
        .all<{ item_id: number; month: string; planned_qty: number; constraint_type: string }>('SELECT item_id, month, planned_qty, constraint_type FROM sop_supply_plan WHERE month BETWEEN ? AND ?', [months[0], months[months.length - 1]])
        .map((s) => [`${s.item_id}:${s.month}`, s]),
    );
    const budget = new Map<string, { qty: number; amount: number }>();
    if (services.has('budgetSales') && ctx.apps.isEnabled('budget')) {
      for (const b of services.get('budgetSales').salesPlan(months[0], months.length)) {
        const k = `${b.itemId}:${b.month}`;
        const cur = budget.get(k) ?? { qty: 0, amount: 0 };
        budget.set(k, { qty: cur.qty + b.qty, amount: cur.amount + b.amount });
      }
    }
    const items = new Set<number>([...demand.map((d) => d.item_id), ...[...supply.keys(), ...budget.keys()].map((k) => Number(k.split(':')[0]))]);
    const itemInfo = new Map(
      [...items].map((id) => {
        const i = catalog().item(id);
        return [id, { sku: i.sku, name_en: i.name_en, name_ar: i.name_ar }];
      }),
    );
    const byKey = new Map(demand.map((d) => [`${d.item_id}:${d.month}`, d]));
    const out = [...items]
      .sort((a, b) => itemInfo.get(a)!.sku.localeCompare(itemInfo.get(b)!.sku))
      .map((itemId) => {
        const price = byKey.get(`${itemId}:${months[0]}`)?.unit_price ?? priceOf(v, itemId);
        const cells = months.map((m) => {
          const k = `${itemId}:${m}`;
          const d = byKey.get(k);
          const s = supply.get(k);
          const b = budget.get(k);
          const demandQty = d?.qty ?? 0;
          const demandValue = d?.amount ?? 0;
          const supplyQty = s?.planned_qty ?? 0;
          const gapQty = supplyQty - demandQty;
          return {
            month: m,
            demand_qty: demandQty,
            demand_value: demandValue,
            supply_qty: supplyQty,
            constraint: s?.constraint_type ?? 'none',
            supply_known: !!s,
            gap_qty: gapQty,
            gap_value: value(gapQty, price),
            budget_qty: b?.qty ?? 0,
            budget_value: b?.amount ?? 0,
            budget_gap_qty: demandQty - (b?.qty ?? 0),
            budget_gap_value: demandValue - (b?.amount ?? 0),
          };
        });
        return { item_id: itemId, ...itemInfo.get(itemId)!, unit_price: price, cells };
      });
    const totals = months.map((m, i) => {
      const t = { month: m, demand_qty: 0, demand_value: 0, supply_qty: 0, gap_qty: 0, gap_value: 0, budget_qty: 0, budget_value: 0, budget_gap_value: 0 };
      for (const r of out) {
        const x = r.cells[i];
        t.demand_qty += x.demand_qty;
        t.demand_value += x.demand_value;
        t.supply_qty += x.supply_qty;
        t.gap_qty += x.gap_qty;
        t.gap_value += x.gap_value;
        t.budget_qty += x.budget_qty;
        t.budget_value += x.budget_value;
        t.budget_gap_value += x.budget_gap_value;
      }
      return t;
    });
    return { cycle: c, version: v, months, rows: out, totals };
  }

  function approvedPlan(period?: string | null): SopApprovedPlan | null {
    const v = db.get<Version & { period: string }>(
      `SELECT v.*, c.period FROM sop_versions v JOIN sop_cycles c ON c.id = v.cycle_id
       WHERE v.status = 'approved' ${period ? 'AND c.period = ?' : ''} ORDER BY c.period DESC LIMIT 1`,
      period ? [period] : [],
    );
    if (!v) return null;
    return {
      cycleId: v.cycle_id,
      period: v.period,
      versionId: v.id,
      versionNo: v.version_no,
      approvedAt: v.approved_at,
      rows: db
        .all<DemandRow & { sku: string }>('SELECT d.*, i.sku FROM sop_demand d JOIN items i ON i.id = d.item_id WHERE d.version_id = ? ORDER BY i.sku, d.month', [v.id])
        .map((r) => ({ itemId: r.item_id, sku: r.sku, month: r.month, qty: r.qty, unitPrice: r.unit_price, amount: r.amount })),
    };
  }

  function recordSupply(input: SopSupplyInput[], source: string, reference: string): number {
    let written = 0;
    db.tx(() => {
      for (const x of input) {
        if (!MONTH.test(x.month) || !Number.isSafeInteger(x.plannedQty) || x.plannedQty < 0) continue;
        const r = db.run(
          `INSERT INTO sop_supply_plan (item_id, month, planned_qty, constraint_type, source, reference, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(item_id, month) DO UPDATE SET planned_qty = excluded.planned_qty, constraint_type = excluded.constraint_type,
             source = excluded.source, reference = excluded.reference, updated_at = excluded.updated_at
           WHERE sop_supply_plan.source <> 'manual'`,
          [x.itemId, x.month, x.plannedQty, x.constraint, source, reference.slice(0, 100), nowIso()],
        );
        written += r.changes;
      }
    });
    return written;
  }

  const contract: SopService = { approvedPlan, recordSupply };
  return { ...contract, cycle, version, rows, monthsOf, createCycle, createVersion, refresh, setOverrides, approve, removeVersion, comparison };
}
