import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { notFound } from '../../kernel/errors.js';
import { addDays, addMonths, daysBetween, nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zOptText, zPositiveMinor } from '../../kernel/validate.js';
import { averageDelay, buckets, expectedDate, forecast, occurrences, type Flow, type FlowSource, type Repeat } from './engine.js';

interface PlanItem {
  id: number;
  name: string;
  direction: 'in' | 'out';
  category: string;
  amount: number;
  start_date: string;
  repeat: Repeat;
  end_date: string | null;
  is_active: number;
  notes: string | null;
}
interface Settings {
  min_cash: number;
  use_habits: number;
  doubtful_days: number;
}

export const CATEGORIES = ['payroll', 'rent', 'tax', 'loan', 'capex', 'owner', 'utilities', 'other'] as const;
const SOURCES: FlowSource[] = ['receivables', 'payables', 'orders', 'cheques', 'payroll', 'planned', 'booked'];

function createCashflow({ db, installed }: ModuleContext) {
  const has = (module: string) => installed.some((m) => m.id === module);
  const settings = (): Settings => db.get<Settings>('SELECT min_cash, use_habits, doubtful_days FROM cashflow_settings WHERE id = 1') ?? { min_cash: 0, use_habits: 1, doubtful_days: 180 };
  const plan = (id: number) => db.get<PlanItem>('SELECT * FROM cash_plan WHERE id = ?', [id]) ?? notFound('cash_plan', id);

  /** Cash and bank balances (company currency) at the end of `asOf`. */
  function cashAccounts(asOf: string) {
    return db.all<{ id: number; code: string; name_en: string; name_ar: string; balance: number }>(
      `SELECT a.id, a.code, a.name_en, a.name_ar, COALESCE(SUM(l.debit - l.credit), 0) AS balance
       FROM accounts a LEFT JOIN ledger l ON l.account_id = a.id AND l.date <= ?
       WHERE a.subtype IN ('cash', 'bank') AND a.is_group = 0
       GROUP BY a.id HAVING a.is_active = 1 OR balance <> 0 ORDER BY a.code`,
      [asOf],
    );
  }

  /** Each customer's amount-weighted delay past the due date over the last year of payments. */
  function customerDelays(asOf: string): Map<number, number> {
    const rows = db.all<{ party_id: number; due_date: string; date: string; amount: number }>(
      `SELECT d.party_id, d.due_date, s.date, s.amount FROM settlements s JOIN documents d ON d.id = s.document_id
       WHERE d.kind = 'sales_invoice' AND s.source_type = 'payment' AND s.date BETWEEN ? AND ?`,
      [addDays(asOf, -365), asOf],
    );
    const by = new Map<number, { dueDate: string; paidDate: string; amount: number }[]>();
    for (const r of rows) by.set(r.party_id, [...(by.get(r.party_id) ?? []), { dueDate: r.due_date, paidDate: r.date, amount: r.amount }]);
    const out = new Map<number, number>();
    for (const [party, list] of by) {
      const d = averageDelay(list);
      if (d != null) out.set(party, d);
    }
    return out;
  }

  function flows(asOf: string, horizonEnd: string, opts: { habits: boolean; doubtfulDays: number }) {
    const out: Flow[] = [];
    const atRisk: { party: string; number: string | null; dueDate: string; amount: number; daysOverdue: number }[] = [];
    if (has('documents')) {
      const delays = opts.habits ? customerDelays(asOf) : new Map<number, number>();
      const docs = db.all<{ id: number; kind: string; number: string | null; party_id: number; party: string; due_date: string; open: number }>(
        `SELECT d.id, d.kind, d.number, d.party_id, p.name AS party, d.due_date, d.base_total - d.base_settled AS open
         FROM documents d JOIN parties p ON p.id = d.party_id
         WHERE d.status = 'posted' AND d.base_total - d.base_settled > 0`,
      );
      for (const d of docs) {
        const label = `${d.party}${d.number ? ' · ' + d.number : ''}`;
        if (d.kind === 'sales_invoice') {
          const overdue = daysBetween(d.due_date, asOf);
          if (opts.doubtfulDays > 0 && overdue > opts.doubtfulDays) {
            atRisk.push({ party: d.party, number: d.number, dueDate: d.due_date, amount: d.open, daysOverdue: overdue });
            continue;
          }
          const date = expectedDate(d.due_date, delays.get(d.party_id) ?? 0, asOf);
          out.push({ date, amount: d.open, source: 'receivables', label, ref: d.number, dueDate: d.due_date });
        } else if (d.kind === 'purchase_bill') {
          out.push({ date: d.due_date < asOf ? asOf : d.due_date, amount: -d.open, source: 'payables', label, ref: d.number, dueDate: d.due_date });
        } else if (d.kind === 'sales_credit') {
          // An unapplied credit note is money we may have to give back (or it lowers the next collection).
          out.push({ date: asOf, amount: -d.open, source: 'receivables', label, ref: d.number, dueDate: d.due_date });
        } else if (d.kind === 'purchase_credit') {
          out.push({ date: asOf, amount: d.open, source: 'payables', label, ref: d.number, dueDate: d.due_date });
        }
      }
    }
    if (has('purchasing')) {
      // Approved orders not yet billed: paid on the supplier's terms after the expected delivery.
      const orders = db.all<{ number: string | null; supplier: string; date: string; expected_date: string | null; terms: number; unbilled: number }>(
        `SELECT o.number, p.name AS supplier, o.date, o.expected_date, p.payment_terms_days AS terms,
                SUM(CASE WHEN l.base_quantity > l.billed_base THEN (l.total * (l.base_quantity - l.billed_base)) / l.base_quantity ELSE 0 END)
                  * (CASE WHEN o.currency IS NULL THEN 1.0 ELSE COALESCE(o.exchange_rate, 1000000) / 1000000.0 END) AS unbilled
         FROM purchase_orders o JOIN parties p ON p.id = o.supplier_id JOIN purchase_order_lines l ON l.po_id = o.id
         WHERE o.status = 'open' GROUP BY o.id`,
      );
      for (const o of orders) {
        if (o.unbilled <= 0) continue;
        const pay = addDays(o.expected_date ?? o.date, o.terms);
        out.push({ date: pay < asOf ? asOf : pay, amount: -Math.round(o.unbilled), source: 'orders', label: `${o.supplier}${o.number ? ' · ' + o.number : ''}`, ref: o.number, dueDate: pay });
      }
    }
    if (has('cheques')) {
      // Cheques not cleared yet: the money moves on the date written on the cheque.
      const open = db.all<{ direction: string; cheque_no: string; due_date: string; amount: number; party: string; number: string }>(
        `SELECT c.direction, c.cheque_no, c.due_date, c.amount, p.name AS party, c.number FROM cheques c JOIN parties p ON p.id = c.party_id
         WHERE c.status IN ('in_hand', 'deposited', 'issued')`,
      );
      for (const c of open) {
        const date = c.due_date < asOf ? asOf : c.due_date;
        out.push({ date, amount: c.direction === 'received' ? c.amount : -c.amount, source: 'cheques', label: `${c.party} · ${c.cheque_no}`, ref: c.number, dueDate: c.due_date });
      }
    }
    if (has('payroll')) {
      // Payrolls prepared or posted but not paid yet.
      for (const r of db.all<{ month: string; pay_date: string; net: number }>(`SELECT month, pay_date, net FROM payroll_runs WHERE status IN ('draft', 'posted') AND net > 0`)) {
        out.push({ date: r.pay_date < asOf ? asOf : r.pay_date, amount: -r.net, source: 'payroll', label: `Payroll ${r.month}`, ref: r.month, dueDate: r.pay_date });
      }
    }
    // Planned receipts and payments (payroll, rent, loans, tax…).
    for (const p of db.all<PlanItem>('SELECT * FROM cash_plan WHERE is_active = 1')) {
      for (const d of occurrences({ startDate: p.start_date, repeat: p.repeat, endDate: p.end_date }, asOf < p.start_date ? p.start_date : addDays(asOf, 1), horizonEnd)) {
        out.push({ date: d, amount: p.direction === 'in' ? p.amount : -p.amount, source: 'planned', label: p.name, ref: `plan:${p.id}` });
      }
    }
    // Cash movements already entered with a future date (post-dated cheques, standing orders).
    const booked = db.all<{ date: string; amount: number; memo: string | null; number: string | null }>(
      `SELECT l.date, SUM(l.debit - l.credit) AS amount, MAX(l.memo) AS memo, MAX(l.number) AS number
       FROM ledger l JOIN accounts a ON a.id = l.account_id
       WHERE a.subtype IN ('cash', 'bank') AND l.date > ? GROUP BY l.entry_id`,
      [asOf],
    );
    for (const b of booked) if (b.amount !== 0) out.push({ date: b.date, amount: b.amount, source: 'booked', label: b.memo ?? b.number ?? '', ref: b.number });
    return { flows: out, atRisk };
  }

  function run(q: { asOf: string; granularity: 'week' | 'month'; periods: number; habits: boolean | null; exclude: FlowSource[] }) {
    const s = settings();
    const periods = buckets(q.asOf, q.granularity, q.periods);
    const accounts = cashAccounts(q.asOf);
    const opening = accounts.reduce((sum, a) => sum + a.balance, 0);
    const f = flows(q.asOf, periods.at(-1)!.to, { habits: q.habits ?? !!s.use_habits, doubtfulDays: s.doubtful_days });
    const used = f.flows.filter((x) => !q.exclude.includes(x.source));
    const result = forecast(opening, periods, used, s.min_cash);
    return {
      asOf: q.asOf,
      granularity: q.granularity,
      settings: { minCash: s.min_cash, useHabits: q.habits ?? !!s.use_habits, doubtfulDays: s.doubtful_days },
      accounts,
      ...result,
      totals: Object.fromEntries(SOURCES.map((src) => [src, used.filter((x) => x.source === src && x.date <= periods.at(-1)!.to).reduce((a, x) => a + x.amount, 0)])),
      atRisk: f.atRisk.sort((a, b) => b.amount - a.amount),
      atRiskTotal: f.atRisk.reduce((a, x) => a + x.amount, 0),
    };
  }

  return { settings, plan, run };
}

const zPlan = z.object({
  name: z.string().trim().min(1).max(120),
  direction: z.enum(['in', 'out']),
  category: z.enum(CATEGORIES).default('other'),
  amount: zPositiveMinor,
  startDate: zDate,
  repeat: z.enum(['once', 'weekly', 'monthly', 'quarterly', 'yearly']).default('once'),
  endDate: zDate.nullish().transform((v) => v ?? null),
  isActive: z.boolean().default(true),
  notes: zOptText(1000),
});

export const cashflowModule: AppModule = {
  id: 'cashflow',
  dependsOn: ['ledger'],
  permissions: ['cashflow.forecast.read', 'cashflow.plan.write'],
  apps: [{ id: 'cashflow', order: 72, permissions: ['cashflow'] }],
  roles: [{ id: 'cash_manager', permissions: ['cashflow.*', 'gl.reports.read', 'gl.accounts.read'] }],
  migrations: [
    {
      id: '001_cashflow',
      up: `
        -- Planned receipts and payments that are not (yet) invoices: payroll, rent, loan instalments, tax, capex.
        CREATE TABLE cash_plan (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL,
          direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
          category    TEXT NOT NULL DEFAULT 'other',
          amount      INTEGER NOT NULL CHECK (amount > 0),
          start_date  TEXT NOT NULL,
          repeat      TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'weekly', 'monthly', 'quarterly', 'yearly')),
          end_date    TEXT,
          is_active   INTEGER NOT NULL DEFAULT 1,
          notes       TEXT,
          created_by  INTEGER REFERENCES users(id),
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE cashflow_settings (
          id            INTEGER PRIMARY KEY CHECK (id = 1),
          min_cash      INTEGER NOT NULL DEFAULT 0,
          use_habits    INTEGER NOT NULL DEFAULT 1,
          doubtful_days INTEGER NOT NULL DEFAULT 180
        );
        INSERT INTO cashflow_settings (id) VALUES (1);
      `,
    },
  ],

  routes(r, ctx) {
    const { db, services } = ctx;
    const cf = createCashflow(ctx);
    const audit = services.get('audit');

    r.get('/cashflow/forecast', 'cashflow.forecast.read', ({ query }) => {
      const q = parse(
        z.object({
          asOf: zDate.default(today()),
          granularity: z.enum(['week', 'month']).default('week'),
          periods: z.coerce.number().int().min(1).max(60).optional(),
          habits: z.enum(['1', '0']).optional(),
          exclude: z.string().optional(),
        }),
        query,
      );
      const exclude = (q.exclude ?? '').split(',').filter((x): x is FlowSource => SOURCES.includes(x as FlowSource));
      return cf.run({ asOf: q.asOf, granularity: q.granularity, periods: q.periods ?? (q.granularity === 'week' ? 13 : 12), habits: q.habits == null ? null : q.habits === '1', exclude });
    });

    r.get('/cashflow/plan', 'cashflow.forecast.read', () => db.all('SELECT * FROM cash_plan ORDER BY is_active DESC, direction, start_date, id'));

    const write = (id: number | null, body: unknown, userId: number) => {
      const p = parse(zPlan, body);
      const row = {
        name: p.name,
        direction: p.direction,
        category: p.category,
        amount: p.amount,
        start_date: p.startDate,
        repeat: p.repeat,
        end_date: p.repeat === 'once' ? null : p.endDate && p.endDate < p.startDate ? p.startDate : p.endDate,
        is_active: p.isActive ? 1 : 0,
        notes: p.notes,
        updated_at: nowIso(),
      };
      return db.tx(() => {
        let out = id;
        if (id == null) out = db.insert('cash_plan', { ...row, created_by: userId, created_at: nowIso() });
        else {
          cf.plan(id);
          db.update('cash_plan', id, row);
        }
        audit.log({ userId, action: id == null ? 'create' : 'update', entity: 'cash_plan', entityId: out!, summary: p.name });
        return out!;
      });
    };
    r.post('/cashflow/plan', 'cashflow.plan.write', ({ body, user }) => ({ id: write(null, body, user.id) }));
    r.put('/cashflow/plan/:id', 'cashflow.plan.write', ({ params, body, user }) => ({ id: write(Number(params.id), body, user.id) }));
    r.delete('/cashflow/plan/:id', 'cashflow.plan.write', ({ params, user }) => {
      const p = cf.plan(Number(params.id));
      db.tx(() => {
        db.run('DELETE FROM cash_plan WHERE id = ?', [p.id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'cash_plan', entityId: p.id, summary: p.name });
      });
      return { ok: true };
    });

    r.get('/cashflow/settings', 'cashflow.forecast.read', () => cf.settings());
    r.put('/cashflow/settings', 'cashflow.plan.write', ({ body, user }) => {
      const s = parse(z.object({ minCash: z.number().int().min(0).max(1e15), useHabits: z.boolean(), doubtfulDays: z.number().int().min(0).max(3650) }), body);
      db.tx(() => {
        db.run('UPDATE cashflow_settings SET min_cash = ?, use_habits = ?, doubtful_days = ? WHERE id = 1', [s.minCash, s.useHabits ? 1 : 0, s.doubtfulDays]);
        audit.log({ userId: user.id, action: 'update', entity: 'cashflow_settings', entityId: 1, summary: `min ${s.minCash}` });
      });
      return { ok: true };
    });

    /** Suggested planned items: expenses paid regularly straight from cash/bank over the last 3 months. */
    r.get('/cashflow/suggestions', 'cashflow.plan.write', ({ query }) => {
      const asOf = parse(z.object({ asOf: zDate.default(today()) }), query).asOf;
      const from = addMonths(asOf, -3);
      const rows = db.all<{ account_id: number; code: string; name_en: string; name_ar: string; months: number; total: number }>(
        `SELECT x.account_id, a.code, a.name_en, a.name_ar, COUNT(DISTINCT substr(x.date, 1, 7)) AS months, SUM(x.debit - x.credit) AS total
         FROM ledger x JOIN accounts a ON a.id = x.account_id
         WHERE a.type = 'expense' AND x.date >= ? AND x.date < ? AND x.source_type = 'manual'
           AND x.entry_id IN (SELECT l.entry_id FROM ledger l JOIN accounts c ON c.id = l.account_id WHERE c.subtype IN ('cash', 'bank'))
         GROUP BY x.account_id HAVING months >= 3 AND total > 0 ORDER BY total DESC LIMIT 20`,
        [from, asOf.slice(0, 8) + '01'],
      );
      const existing = new Set(db.all<{ name: string }>('SELECT name FROM cash_plan').map((p) => p.name));
      return rows
        .map((r) => ({ ...r, monthly: Math.round(r.total / 3) }))
        .filter((r) => !existing.has(r.name_en) && !existing.has(r.name_ar));
    });

  },
};
