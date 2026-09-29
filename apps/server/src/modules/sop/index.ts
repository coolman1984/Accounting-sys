import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { nowIso, today } from '../../kernel/dates.js';
import { parse, zId, zOptId, zOptText } from '../../kernel/validate.js';
import type { SopService } from '../../contracts/sop.js';
import { CONSTRAINTS, migrations } from './schema.js';
import { createSop, MONTH, monthPlus, type SopInternal } from './service.js';
import { wireSopEco } from './eco.js';

const zMonth = z.string().regex(MONTH, 'Invalid month (YYYY-MM)');

export const sopModule: AppModule = {
  id: 'sop',
  // Firm orders and invoiced history come from the sales service; the budget and prices are optional services.
  dependsOn: ['sales', 'catalog'],
  after: ['eco'],
  migrations,
  permissions: ['sop.plans.read', 'sop.plans.write', 'sop.plans.approve', 'sop.supply.write'],
  apps: [{ id: 'sop', order: 16, requires: ['sd'], permissions: ['sop'] }],
  roles: [
    { id: 'demand_planner', permissions: ['sop.plans.read', 'sop.plans.write', 'sop.supply.write', 'sales.orders.read', 'sales.reports.read', 'catalog.items.read', 'budget.budgets.read'] },
    { id: 'sop_approver', permissions: ['sop.plans.read', 'sop.plans.approve', 'sales.reports.read'] },
  ],
  // Consensus is a separate duty: whoever writes the plan does not approve it.
  sod: [['sop.plans.write', 'sop.plans.approve']],

  setup(ctx) {
    ctx.services.provide('sop', createSop(ctx) as SopService);
    wireSopEco(ctx);
  },

  routes(r, { db, services }) {
    const sop = services.get('sop') as unknown as SopInternal;

    r.get('/sop/cycles', 'sop.plans.read', () =>
      db.all(
        `SELECT c.*, (SELECT COUNT(*) FROM sop_versions v WHERE v.cycle_id = c.id) AS versions,
                (SELECT v.version_no FROM sop_versions v WHERE v.cycle_id = c.id AND v.status = 'approved') AS approved_version
         FROM sop_cycles c ORDER BY c.period DESC`,
      ),
    );
    r.post('/sop/cycles', 'sop.plans.write', ({ body, user }) => {
      const input = parse(z.object({ period: zMonth, startMonth: zMonth.nullish(), months: z.number().int().min(1).max(24).default(12), notes: zOptText(1000) }), body);
      return { id: sop.createCycle(input, user.id) };
    });
    r.get('/sop/cycles/:id', 'sop.plans.read', ({ params }) => {
      const c = sop.cycle(Number(params.id));
      const versions = db.all(
        `SELECT v.*, (SELECT COALESCE(SUM(qty), 0) FROM sop_demand d WHERE d.version_id = v.id) AS total_qty,
                (SELECT COALESCE(SUM(amount), 0) FROM sop_demand d WHERE d.version_id = v.id) AS total_amount,
                u.display_name AS approved_by_name
         FROM sop_versions v LEFT JOIN users u ON u.id = v.approved_by WHERE v.cycle_id = ? ORDER BY v.version_no DESC`,
        [c.id],
      );
      return { ...c, months_list: sop.monthsOf(c), versions };
    });

    r.post('/sop/cycles/:id/versions', 'sop.plans.write', ({ params, body, user }) => {
      const input = parse(z.object({ baselineMonths: z.number().int().min(1).max(24).default(3), priceListId: zOptId, copyFrom: zOptId, notes: zOptText(1000) }), body ?? {});
      return { id: sop.createVersion(Number(params.id), input, user.id) };
    });

    /** A version as a grid: one row per item with its months. */
    r.get('/sop/versions/:id', 'sop.plans.read', ({ params }) => {
      const v = sop.version(Number(params.id));
      const c = sop.cycle(v.cycle_id);
      const months = sop.monthsOf(c);
      const items = new Map<number, any>();
      for (const d of db.all<any>('SELECT d.*, i.sku, i.name_en, i.name_ar FROM sop_demand d JOIN items i ON i.id = d.item_id WHERE d.version_id = ? ORDER BY i.sku, d.month', [v.id])) {
        const row = items.get(d.item_id) ?? { item_id: d.item_id, sku: d.sku, name_en: d.name_en, name_ar: d.name_ar, unit_price: d.unit_price, cells: [] as any[], qty: 0, amount: 0 };
        row.cells.push({ month: d.month, baseline_qty: d.baseline_qty, firm_qty: d.firm_qty, override_qty: d.override_qty, qty: d.qty, amount: d.amount });
        row.qty += d.qty;
        row.amount += d.amount;
        items.set(d.item_id, row);
      }
      const rows = [...items.values()];
      const totals = months.map((m, i) => ({ month: m, qty: rows.reduce((s, x) => s + (x.cells[i]?.qty ?? 0), 0), amount: rows.reduce((s, x) => s + (x.cells[i]?.amount ?? 0), 0) }));
      return { ...v, cycle: c, months, rows, totals };
    });
    r.put('/sop/versions/:id/lines', 'sop.plans.write', ({ params, body, user }) => {
      const input = parse(z.object({ lines: z.array(z.object({ itemId: zId, month: zMonth, qty: z.number().int().min(0).nullable() })).min(1).max(5000) }), body);
      sop.setOverrides(Number(params.id), input.lines, user.id);
      return { ok: true };
    });
    r.post('/sop/versions/:id/refresh', 'sop.plans.write', ({ params, user }) => (sop.refresh(Number(params.id), user.id), { ok: true }));
    r.post('/sop/versions/:id/approve', 'sop.plans.approve', ({ params, user }) => (sop.approve(Number(params.id), user.id), { ok: true }));
    r.delete('/sop/versions/:id', 'sop.plans.write', ({ params, user }) => (sop.removeVersion(Number(params.id), user.id), { ok: true }));
    r.get('/sop/versions/:id/comparison', 'sop.plans.read', ({ params }) => sop.comparison(Number(params.id)));

    /** The approved plan of a cycle (what the integration publishes). */
    r.get('/sop/approved', 'sop.plans.read', ({ query }) => sop.approvedPlan(query.period ?? null));

    // ------------------------------------------------------ planned supply (from manufacturing)
    r.get('/sop/supply', 'sop.plans.read', ({ query }) => {
      const q = parse(z.object({ from: zMonth.nullish(), months: z.coerce.number().int().min(1).max(36).default(12) }), query);
      const from = q.from ?? today().slice(0, 7);
      return db.all(
        `SELECT s.*, i.sku, i.name_en, i.name_ar FROM sop_supply_plan s JOIN items i ON i.id = s.item_id
         WHERE s.month BETWEEN ? AND ? ORDER BY i.sku, s.month`,
        [from, monthPlus(from, q.months - 1)],
      );
    });
    r.put('/sop/supply', 'sop.supply.write', ({ body, user }) => {
      const input = parse(
        z.object({
          rows: z
            .array(z.object({ itemId: zId, month: zMonth, plannedQty: z.number().int().min(0), constraint: z.enum(CONSTRAINTS).default('none'), source: z.string().trim().min(1).max(40).default('manual'), reference: zOptText(100) }))
            .max(20000),
        }),
        body,
      );
      db.tx(() => {
        for (const x of input.rows) {
          services.get('catalog').item(x.itemId);
          db.run(
            `INSERT INTO sop_supply_plan (item_id, month, planned_qty, constraint_type, source, reference, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(item_id, month) DO UPDATE SET planned_qty = excluded.planned_qty, constraint_type = excluded.constraint_type,
               source = excluded.source, reference = excluded.reference, updated_at = excluded.updated_at`,
            [x.itemId, x.month, x.plannedQty, x.constraint, x.source, x.reference, nowIso()],
          );
        }
        services.get('audit').log({ userId: user.id, action: 'update', entity: 'sop_supply_plan', summary: `${input.rows.length} rows` });
      });
      return { ok: true };
    });
  },
};
