import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { assertApp, conflict, fail, notFound } from '../../kernel/errors.js';
import { addDays, addMonths, nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import { flexibleVariances, salesVariances, seedMonths, type SalesItemInput } from './engine.js';
import type { BudgetSalesRow, BudgetSalesService } from '../../contracts/budget.js';

interface Budget {
  id: number;
  name: string;
  start_date: string;
  months: number;
  status: 'draft' | 'approved';
  notes: string | null;
  created_at: string;
  approved_at: string | null;
}
interface LineRow {
  id: number;
  budget_id: number;
  account_id: number;
  cost_center_id: number | null;
  amounts: string;
}
interface SalesRow {
  id: number;
  budget_id: number;
  item_id: number;
  quantities: string;
  unit_price: number;
  unit_cost: number;
}

const MONTHS = 12;
const zAmounts = z.array(z.number().int().min(-1e15).max(1e15)).length(MONTHS);
const zQuantities = z.array(z.number().int().min(0).max(1e15)).length(MONTHS);

function createBudgets({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const audit = () => services.get('audit');
  const get = (id: number) => db.get<Budget>('SELECT * FROM budgets WHERE id = ?', [id]) ?? notFound('budget', id);
  const assertDraft = (b: Budget) => {
    if (b.status !== 'draft') conflict('budget.approved', 'An approved budget is locked — reopen it or make a copy');
  };
  /** First and last day of budget month `m` (1-based). */
  const monthRange = (b: Budget, m: number) => {
    const from = addMonths(b.start_date, m - 1);
    return { from, to: addDays(addMonths(b.start_date, m), -1) };
  };

  /** Actual movement per account and month from the ledger (closing entries excluded), optionally for one cost center. */
  function actualsByMonth(b: Budget, costCenterId: number | null): Map<number, number[]> {
    const out = new Map<number, number[]>();
    const rows = db.all<{ account_id: number; ym: string; amount: number }>(
      `SELECT l.account_id, substr(l.date, 1, 7) AS ym, SUM(l.debit - l.credit) AS amount
       FROM ledger l JOIN accounts a ON a.id = l.account_id
       WHERE l.date BETWEEN ? AND ? AND a.type IN ('income', 'expense')
         AND l.source_type NOT IN ('closing', 'closing_reversal')
         ${costCenterId ? 'AND l.cost_center_id = ?' : ''}
       GROUP BY l.account_id, ym`,
      costCenterId ? [b.start_date, monthRange(b, b.months).to, costCenterId] : [b.start_date, monthRange(b, b.months).to],
    );
    const months = Array.from({ length: b.months }, (_, i) => monthRange(b, i + 1).from.slice(0, 7));
    for (const r of rows) {
      const i = months.indexOf(r.ym);
      if (i < 0) continue;
      const arr = out.get(r.account_id) ?? Array(b.months).fill(0);
      arr[i] += r.amount;
      out.set(r.account_id, arr);
    }
    return out;
  }

  function checkLines(lines: { accountId: number; costCenterId: number | null }[]) {
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      const a = ledger().account(l.accountId);
      if (a.is_group) fail('budget.group_account', `Line ${i + 1}: ${a.code} is a group account`, { line: i + 1, code: a.code });
      if (a.type !== 'income' && a.type !== 'expense') fail('budget.pl_only', `Line ${i + 1}: only income and expense accounts are budgeted`, { line: i + 1, code: a.code });
      const k = `${l.accountId}:${l.costCenterId ?? ''}`;
      if (seen.has(k)) fail('budget.duplicate_line', `Line ${i + 1}: ${a.code} appears twice`, { line: i + 1, code: a.code });
      seen.add(k);
      if (l.costCenterId && services.has('costCenters')) services.get('costCenters').assertUsable(l.costCenterId);
    });
  }

  /**
   * A new budget, empty or seeded from actuals of an earlier period (e.g. last year) with an uplift,
   * keeping last year's monthly pattern ("seasonal") or spreading the year evenly.
   */
  function create(input: { name: string; startDate: string; notes: string | null; seed: { from: string; upliftBp: number; pattern: 'seasonal' | 'even' } | null; copyOf: number | null }, userId: number | null): number {
    const start = input.startDate.slice(0, 8) + '01';
    return db.tx(() => {
      const id = db.insert('budgets', { name: input.name, start_date: start, months: MONTHS, status: 'draft', notes: input.notes, created_by: userId, created_at: nowIso() });
      if (input.copyOf) {
        const src = get(input.copyOf);
        for (const l of db.all<LineRow>('SELECT * FROM budget_lines WHERE budget_id = ?', [src.id])) db.insert('budget_lines', { budget_id: id, account_id: l.account_id, cost_center_id: l.cost_center_id, amounts: l.amounts });
        for (const s of db.all<SalesRow>('SELECT * FROM budget_sales WHERE budget_id = ?', [src.id])) db.insert('budget_sales', { budget_id: id, item_id: s.item_id, quantities: s.quantities, unit_price: s.unit_price, unit_cost: s.unit_cost });
      } else if (input.seed) {
        const seedBudget: Budget = { id: 0, name: '', start_date: input.seed.from.slice(0, 8) + '01', months: MONTHS, status: 'draft', notes: null, created_at: '', approved_at: null };
        const act = actualsByMonth(seedBudget, null);
        const types = new Map(ledger().accounts().map((a) => [a.id, a.type]));
        const factor = 1 + input.seed.upliftBp / 10000;
        const newBudget: Budget = { ...seedBudget, start_date: start };
        const sourceMonths = Array.from({ length: MONTHS }, (_, i) => monthRange(seedBudget, i + 1).from.slice(0, 7));
        const budgetMonths = Array.from({ length: MONTHS }, (_, i) => monthRange(newBudget, i + 1).from.slice(0, 7));
        // A month still running (or in the future) has no full actuals yet.
        const complete = Array.from({ length: MONTHS }, (_, i) => monthRange(seedBudget, i + 1).to < today());
        for (const [accountId, months] of act) {
          const sign = types.get(accountId) === 'income' ? -1 : 1; // credit-normal revenue
          const values = months.map((v) => Math.round(v * sign * factor));
          if (values.every((v, i) => v === 0 || !complete[i])) continue;
          const amounts = seedMonths(values, sourceMonths, complete, budgetMonths, input.seed.pattern);
          db.insert('budget_lines', { budget_id: id, account_id: accountId, cost_center_id: null, amounts: JSON.stringify(amounts) });
        }
      }
      audit().log({ userId, action: 'create', entity: 'budget', entityId: id, summary: input.name });
      return id;
    });
  }

  function saveLines(id: number, lines: { accountId: number; costCenterId: number | null; amounts: number[] }[], userId: number | null) {
    assertDraft(get(id));
    checkLines(lines);
    db.tx(() => {
      db.run('DELETE FROM budget_lines WHERE budget_id = ?', [id]);
      for (const l of lines) db.insert('budget_lines', { budget_id: id, account_id: l.accountId, cost_center_id: l.costCenterId, amounts: JSON.stringify(l.amounts) });
      audit().log({ userId, action: 'update', entity: 'budget', entityId: id, summary: `${lines.length} lines` });
    });
  }

  function saveSales(id: number, rows: { itemId: number; quantities: number[]; unitPrice: number; unitCost: number }[], userId: number | null) {
    assertDraft(get(id));
    if (!services.has('catalog')) fail('budget.no_items', 'A sales budget by item needs products and services');
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.itemId)) fail('budget.duplicate_item', 'An item appears twice');
      seen.add(r.itemId);
      services.get('catalog').item(r.itemId);
    }
    db.tx(() => {
      db.run('DELETE FROM budget_sales WHERE budget_id = ?', [id]);
      for (const r of rows) db.insert('budget_sales', { budget_id: id, item_id: r.itemId, quantities: JSON.stringify(r.quantities), unit_price: r.unitPrice, unit_cost: r.unitCost });
      audit().log({ userId, action: 'update', entity: 'budget', entityId: id, summary: `${rows.length} sales lines` });
    });
  }

  const inRange = (arr: number[], fromMonth: number, toMonth: number) => arr.slice(fromMonth - 1, toMonth).reduce((s, v) => s + v, 0);

  /** Budget vs actual for months `fromMonth..toMonth`: static, flexible and actual, with favourable/unfavourable variances. */
  function variance(id: number, fromMonth: number, toMonth: number, costCenterId: number | null) {
    const b = get(id);
    const accounts = new Map(ledger().accounts().map((a) => [a.id, a]));
    const lines = db.all<LineRow>(`SELECT * FROM budget_lines WHERE budget_id = ? ${costCenterId ? 'AND cost_center_id = ?' : ''}`, costCenterId ? [id, costCenterId] : [id]);
    const budgetByAccount = new Map<number, number>();
    for (const l of lines) budgetByAccount.set(l.account_id, (budgetByAccount.get(l.account_id) ?? 0) + inRange(JSON.parse(l.amounts), fromMonth, toMonth));
    const actual = actualsByMonth(b, costCenterId);
    const ids = new Set([...budgetByAccount.keys(), ...actual.keys()]);
    const input = [...ids]
      .map((accountId) => {
        const a = accounts.get(accountId)!;
        const type = a.type as 'income' | 'expense';
        const act = inRange(actual.get(accountId) ?? [], fromMonth, toMonth) * (type === 'income' ? -1 : 1);
        const variableBp = a.variable_bp ?? (a.subtype === 'cogs' ? 10000 : 0);
        // Interest and income tax sit below operating profit and do not move with sales.
        const vb = ['interest_expense', 'income_tax'].includes(a.subtype) ? 0 : variableBp;
        return { accountId, type, variableBp: vb, budget: budgetByAccount.get(accountId) ?? 0, actual: act };
      })
      .filter((l) => l.budget !== 0 || l.actual !== 0);
    const v = flexibleVariances(input);
    const rows = v.lines
      .map((l) => {
        const a = accounts.get(l.accountId)!;
        return { ...l, code: a.code, name_en: a.name_en, name_ar: a.name_ar, subtype: a.subtype, unbudgeted: !budgetByAccount.has(l.accountId) };
      })
      .sort((x, y) => x.code.localeCompare(y.code));
    // Performance is judged after removing the effect of sales volume: rank by the flexible-budget variance.
    const worst = [...rows].filter((r) => r.flexibleVariance < 0).sort((x, y) => x.flexibleVariance - y.flexibleVariance).slice(0, 5);
    return {
      budget: b,
      fromMonth,
      toMonth,
      period: { from: monthRange(b, fromMonth).from, to: monthRange(b, toMonth).to },
      costCenterId,
      activityIndex: v.index,
      rows,
      totals: v.totals,
      worst,
    };
  }

  /** Item sales: budget quantity × price against invoices and credit notes of the same months. */
  function salesVariance(id: number, fromMonth: number, toMonth: number) {
    const b = get(id);
    const period = { from: monthRange(b, fromMonth).from, to: monthRange(b, toMonth).to };
    if (!services.has('catalog')) return { budget: b, fromMonth, toMonth, period, rows: [], totals: salesVariances([]).totals };
    const budget = db.all<SalesRow>('SELECT * FROM budget_sales WHERE budget_id = ?', [id]);
    const actual = services.has('documents')
      ? db.all<{ item_id: number; qty: number; revenue: number }>(
          `SELECT l.item_id, SUM(CASE WHEN d.kind = 'sales_invoice' THEN l.base_quantity ELSE -l.base_quantity END) AS qty,
                  SUM(CASE WHEN d.kind = 'sales_invoice' THEN l.base_net ELSE -l.base_net END) AS revenue
           FROM document_lines l JOIN documents d ON d.id = l.document_id
           WHERE d.kind IN ('sales_invoice', 'sales_credit') AND d.status = 'posted' AND l.item_id IS NOT NULL AND d.date BETWEEN ? AND ?
           GROUP BY l.item_id`,
          [period.from, period.to],
        )
      : [];
    const items = new Map<number, SalesItemInput>();
    for (const s of budget) {
      items.set(s.item_id, { itemId: s.item_id, budgetQty: inRange(JSON.parse(s.quantities), fromMonth, toMonth), budgetPrice: s.unit_price, budgetCost: s.unit_cost, actualQty: 0, actualRevenue: 0 });
    }
    for (const a of actual) {
      const cur = items.get(a.item_id);
      if (cur) Object.assign(cur, { actualQty: a.qty, actualRevenue: a.revenue });
      else {
        // Sold but never budgeted: its list price stands in for the budget price (no price variance if absent).
        const listPrice = services.get('catalog').item(a.item_id).sale_price ?? 0;
        const price = listPrice || (a.qty ? Math.round((a.revenue * 1000) / a.qty) : 0);
        items.set(a.item_id, { itemId: a.item_id, budgetQty: 0, budgetPrice: price, budgetCost: 0, actualQty: a.qty, actualRevenue: a.revenue, unbudgeted: true });
      }
    }
    const v = salesVariances([...items.values()]);
    const names = new Map(db.all<{ id: number; sku: string; name_en: string; name_ar: string }>('SELECT id, sku, name_en, name_ar FROM items').map((i) => [i.id, i]));
    return { budget: b, fromMonth, toMonth, period, rows: v.rows.map((r) => ({ ...r, ...names.get(r.itemId) })), totals: v.totals };
  }

  return { get, create, saveLines, saveSales, variance, salesVariance, assertDraft, monthRange };
}

export const budgetModule: AppModule = {
  id: 'budget',
  dependsOn: ['ledger'],
  permissions: ['budget.budgets.read', 'budget.budgets.write', 'budget.budgets.approve', 'budget.reports.read'],
  apps: [{ id: 'budget', order: 75, permissions: ['budget'] }],
  roles: [{ id: 'budget_controller', permissions: ['budget.*', 'gl.reports.read', 'gl.accounts.read'] }],
  sod: [['budget.budgets.write', 'budget.budgets.approve']],
  migrations: [
    {
      id: '001_budgets',
      up: `
        CREATE TABLE budgets (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL,
          start_date  TEXT NOT NULL,             -- first day of the first month
          months      INTEGER NOT NULL DEFAULT 12,
          status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
          notes       TEXT,
          created_by  INTEGER,
          created_at  TEXT NOT NULL,
          approved_by INTEGER,
          approved_at TEXT
        );
        -- One row per account (and cost center): the monthly amounts as a JSON array, positive = normal side.
        CREATE TABLE budget_lines (
          id             INTEGER PRIMARY KEY,
          budget_id      INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
          account_id     INTEGER NOT NULL REFERENCES accounts(id),
          cost_center_id INTEGER,
          amounts        TEXT NOT NULL
        );
        CREATE UNIQUE INDEX budget_lines_key ON budget_lines(budget_id, account_id, IFNULL(cost_center_id, 0));
        -- Sales budget by item: monthly quantities (× 1000, base unit), budget unit price and unit cost.
        CREATE TABLE budget_sales (
          id         INTEGER PRIMARY KEY,
          budget_id  INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
          item_id    INTEGER NOT NULL,
          quantities TEXT NOT NULL,
          unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
          unit_cost  INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
          UNIQUE (budget_id, item_id)
        );
      `,
    },
  ],

  setup({ db, services }) {
    // The sales budget for other modules (S&OP compares its demand plan with it).
    const svc: BudgetSalesService = {
      salesPlan(fromMonth, months) {
        const wanted = new Set(Array.from({ length: months }, (_, i) => addMonths(fromMonth + '-01', i).slice(0, 7)));
        const budgets = db.all<Budget & { approved_at: string | null }>(
          `SELECT * FROM budgets WHERE EXISTS (SELECT 1 FROM budget_sales s WHERE s.budget_id = budgets.id)
           ORDER BY (status = 'approved') DESC, approved_at DESC, id DESC`,
        );
        const taken = new Set<string>();
        const out: BudgetSalesRow[] = [];
        for (const b of budgets) {
          const monthsOf = Array.from({ length: b.months }, (_, i) => addMonths(b.start_date, i).slice(0, 7));
          const mine = monthsOf.map((m, i) => ({ m, i })).filter((x) => wanted.has(x.m) && !taken.has(x.m));
          if (!mine.length) continue;
          for (const s of db.all<SalesRow>('SELECT * FROM budget_sales WHERE budget_id = ?', [b.id])) {
            const q = JSON.parse(s.quantities) as number[];
            for (const { m, i } of mine) {
              const qty = q[i] ?? 0;
              if (!qty) continue;
              out.push({ budgetId: b.id, budgetName: b.name, status: b.status, itemId: s.item_id, month: m, qty, unitPrice: s.unit_price, amount: Math.round((qty * s.unit_price) / 1000) });
            }
          }
          mine.forEach((x) => taken.add(x.m));
        }
        return out;
      },
    };
    services.provide('budgetSales', svc);
  },

  routes(r, ctx) {
    const { db, services, apps } = ctx;
    const bud = createBudgets(ctx);
    const audit = services.get('audit');

    r.get('/budgets', 'budget.budgets.read', () =>
      db.all(
        `SELECT b.*, (SELECT COUNT(*) FROM budget_lines l WHERE l.budget_id = b.id) AS lines,
                (SELECT COUNT(*) FROM budget_sales s WHERE s.budget_id = b.id) AS sales_lines
         FROM budgets b ORDER BY b.start_date DESC, b.id DESC`,
      ),
    );

    r.get('/budgets/:id', 'budget.budgets.read', ({ params }) => {
      const b = bud.get(Number(params.id));
      const lines = db
        .all<LineRow & { code: string; name_en: string; name_ar: string; type: string; subtype: string }>(
          `SELECT l.*, a.code, a.name_en, a.name_ar, a.type, a.subtype FROM budget_lines l JOIN accounts a ON a.id = l.account_id
           WHERE l.budget_id = ? ORDER BY a.code, l.cost_center_id`,
          [b.id],
        )
        .map((l) => ({ ...l, amounts: JSON.parse(l.amounts) as number[] }));
      const sales = !services.has('catalog') ? [] : db
        .all<SalesRow & { sku: string; name_en: string; name_ar: string }>(
          `SELECT s.*, i.sku, i.name_en, i.name_ar FROM budget_sales s JOIN items i ON i.id = s.item_id WHERE s.budget_id = ? ORDER BY i.sku`,
          [b.id],
        )
        .map((s) => ({ ...s, quantities: JSON.parse(s.quantities) as number[] }));
      const months = Array.from({ length: b.months }, (_, i) => bud.monthRange(b, i + 1).from.slice(0, 7));
      return { ...b, months, lines, sales };
    });

    const zCreate = z.object({
      name: z.string().trim().min(1).max(100),
      startDate: zDate,
      notes: zOptText(1000),
      seed: z.object({ from: zDate, upliftBp: z.number().int().min(-10000).max(100000).default(0), pattern: z.enum(['seasonal', 'even']).default('seasonal') }).nullish().transform((v) => v ?? null),
      copyOf: zOptId.transform((v) => v ?? null),
    });
    r.post('/budgets', 'budget.budgets.write', ({ body, user }) => ({ id: bud.create(parse(zCreate, body), user.id) }));

    r.put('/budgets/:id', 'budget.budgets.write', ({ params, body, user }) => {
      const b = bud.get(Number(params.id));
      bud.assertDraft(b);
      const q = parse(z.object({ name: z.string().trim().min(1).max(100), notes: zOptText(1000) }), body);
      db.tx(() => {
        db.run('UPDATE budgets SET name = ?, notes = ? WHERE id = ?', [q.name, q.notes, b.id]);
        audit.log({ userId: user.id, action: 'update', entity: 'budget', entityId: b.id, summary: q.name });
      });
      return { ok: true };
    });

    r.put('/budgets/:id/lines', 'budget.budgets.write', ({ params, body, user }) => {
      const { lines } = parse(z.object({ lines: z.array(z.object({ accountId: zId, costCenterId: zOptId.transform((v) => v ?? null), amounts: zAmounts })).max(2000) }), body);
      bud.saveLines(Number(params.id), lines, user.id);
      return { ok: true };
    });

    r.put('/budgets/:id/sales', 'budget.budgets.write', ({ params, body, user }) => {
      const { rows } = parse(z.object({ rows: z.array(z.object({ itemId: zId, quantities: zQuantities, unitPrice: z.number().int().min(0), unitCost: z.number().int().min(0).default(0) })).max(2000) }), body);
      bud.saveSales(Number(params.id), rows, user.id);
      return { ok: true };
    });

    r.post('/budgets/:id/approve', 'budget.budgets.approve', ({ params, user }) => {
      const b = bud.get(Number(params.id));
      bud.assertDraft(b);
      db.tx(() => {
        db.run(`UPDATE budgets SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`, [user.id, nowIso(), b.id]);
        audit.log({ userId: user.id, action: 'approve', entity: 'budget', entityId: b.id, summary: b.name });
      });
      return { ok: true };
    });

    r.post('/budgets/:id/reopen', 'budget.budgets.approve', ({ params, user }) => {
      const b = bud.get(Number(params.id));
      if (b.status !== 'approved') conflict('budget.not_approved', 'This budget is not approved');
      db.tx(() => {
        db.run(`UPDATE budgets SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = ?`, [b.id]);
        audit.log({ userId: user.id, action: 'reopen', entity: 'budget', entityId: b.id, summary: b.name });
      });
      return { ok: true };
    });

    r.delete('/budgets/:id', 'budget.budgets.write', ({ params, user }) => {
      const b = bud.get(Number(params.id));
      bud.assertDraft(b);
      db.tx(() => {
        db.run('DELETE FROM budgets WHERE id = ?', [b.id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'budget', entityId: b.id, summary: b.name });
      });
      return { ok: true };
    });

    const zRange = z.object({
      fromMonth: z.coerce.number().int().min(1).max(12).default(1),
      toMonth: z.coerce.number().int().min(1).max(12).default(12),
      costCenterId: zOptId.transform((v) => v ?? null),
    });
    r.get('/budgets/:id/variance', 'budget.reports.read', ({ params, query }) => {
      const q = parse(zRange, query);
      if (q.fromMonth > q.toMonth) fail('budget.bad_range', 'The first month must come before the last');
      if (q.costCenterId) assertApp(apps, 'co');
      return bud.variance(Number(params.id), q.fromMonth, q.toMonth, q.costCenterId);
    });

    r.get('/budgets/:id/sales-variance', 'budget.reports.read', ({ params, query }) => {
      const q = parse(zRange, query);
      if (q.fromMonth > q.toMonth) fail('budget.bad_range', 'The first month must come before the last');
      return bud.salesVariance(Number(params.id), q.fromMonth, q.toMonth);
    });
  },
};
