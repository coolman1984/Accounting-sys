import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zOptId } from '../../kernel/validate.js';
import type { CostCenter, CostCentersService } from '../../contracts/co.js';

const zCostCenter = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  parentId: zOptId.transform((v) => v ?? null),
  isActive: z.boolean().default(true),
});

/**
 * Controlling (like SAP CO-CCA, kept small): cost centers are a dimension on
 * ledger lines — no second set of books. Income and expense lines of journal
 * entries, invoices and bills may carry a cost center; the profit & loss by
 * cost center comes straight from the ledger.
 */
export const coModule: AppModule = {
  id: 'co',
  dependsOn: ['ledger'],
  permissions: ['co.costcenters.read', 'co.costcenters.write', 'co.reports.read'],
  apps: [{ id: 'co', order: 35, permissions: ['co'] }],
  roles: [{ id: 'controller', permissions: ['co.*', 'gl.reports.read', 'gl.accounts.read'] }],
  migrations: [
    {
      id: '001_cost_centers',
      up: `
        CREATE TABLE cost_centers (
          id         INTEGER PRIMARY KEY,
          code       TEXT NOT NULL UNIQUE,
          name_en    TEXT NOT NULL,
          name_ar    TEXT NOT NULL,
          parent_id  INTEGER REFERENCES cost_centers(id),
          is_active  INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
      `,
    },
  ],

  setup({ db, services }) {
    const get = (id: number) => db.get<CostCenter>('SELECT * FROM cost_centers WHERE id = ?', [id]) ?? notFound('cost_center', id);
    const service: CostCentersService = {
      assertUsable(id) {
        const cc = get(id);
        if (!cc.is_active) fail('co.inactive', `Cost center ${cc.code} is inactive`, { code: cc.code });
        return cc;
      },
    };
    services.provide('costCenters', service);
  },

  health({ db }) {
    // Every cost center used on the ledger must exist.
    const orphans = db.get<{ n: number }>(
      'SELECT COUNT(*) n FROM journal_lines l WHERE l.cost_center_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_centers c WHERE c.id = l.cost_center_id)',
    )!.n;
    return [{ id: 'references', ok: orphans === 0, details: { count: orphans } }];
  },

  routes(r, { db, services }) {
    const audit = services.get('audit');
    const ledger = services.get('ledger');

    r.get('/cost-centers', 'co.costcenters.read', () =>
      db.all(
        `SELECT c.*, (SELECT COUNT(*) FROM journal_lines l WHERE l.cost_center_id = c.id) AS lines
         FROM cost_centers c ORDER BY c.code`,
      ),
    );

    const check = (input: z.infer<typeof zCostCenter>, selfId: number | null) => {
      const dup = db.get<{ id: number }>('SELECT id FROM cost_centers WHERE code = ?', [input.code]);
      if (dup && dup.id !== selfId) conflict('co.duplicate_code', `Code ${input.code} already exists`);
      // A parent must exist and must not be the cost center itself or one of its children.
      for (let p = input.parentId; p != null; ) {
        if (p === selfId) fail('co.cycle', 'A cost center cannot be under itself');
        p = (db.get<{ parent_id: number | null }>('SELECT parent_id FROM cost_centers WHERE id = ?', [p]) ?? notFound('cost_center', p)).parent_id;
      }
    };
    const row = (i: z.infer<typeof zCostCenter>) => ({ code: i.code, name_en: i.nameEn, name_ar: i.nameAr, parent_id: i.parentId, is_active: i.isActive });

    r.post('/cost-centers', 'co.costcenters.write', ({ body, user }) => {
      const input = parse(zCostCenter, body);
      check(input, null);
      return db.tx(() => {
        const id = db.insert('cost_centers', { ...row(input), created_at: nowIso() });
        audit.log({ userId: user.id, action: 'create', entity: 'cost_center', entityId: id, summary: input.code });
        return { id };
      });
    });

    r.put('/cost-centers/:id', 'co.costcenters.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zCostCenter, body);
      check(input, id);
      db.tx(() => {
        db.update('cost_centers', id, row(input));
        audit.log({ userId: user.id, action: 'update', entity: 'cost_center', entityId: id, summary: input.code });
      });
      return { ok: true };
    });

    r.delete('/cost-centers/:id', 'co.costcenters.write', ({ params, user }) => {
      const id = Number(params.id);
      if (db.get('SELECT 1 FROM journal_lines WHERE cost_center_id = ? LIMIT 1', [id])) conflict('co.in_use', 'This cost center has postings — deactivate it instead');
      if (db.get('SELECT 1 FROM cost_centers WHERE parent_id = ? LIMIT 1', [id])) conflict('co.has_children', 'Move or delete its child cost centers first');
      db.tx(() => {
        db.run('DELETE FROM cost_centers WHERE id = ?', [id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'cost_center', entityId: id });
      });
      return { ok: true };
    });

    /** Profit & loss by cost center: income and expense accounts × cost centers, from the ledger. */
    r.get('/reports/cost-centers', 'co.reports.read', ({ query }) => {
      const t = today();
      const fy = ledger.fiscalYears().find((f) => f.start_date <= t && f.end_date >= t);
      const def = fy ? { from: fy.start_date, to: fy.end_date } : { from: t.slice(0, 4) + '-01-01', to: t.slice(0, 4) + '-12-31' };
      const q = parse(z.object({ from: zDate.default(def.from), to: zDate.default(def.to) }), query);
      const rows = db.all<{ account_id: number; code: string; name_en: string; name_ar: string; type: 'income' | 'expense'; cost_center_id: number | null; amount: number }>(
        `SELECT a.id AS account_id, a.code, a.name_en, a.name_ar, a.type, l.cost_center_id,
                SUM(CASE WHEN a.type = 'income' THEN l.credit - l.debit ELSE l.debit - l.credit END) AS amount
         FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE a.type IN ('income', 'expense') AND l.date BETWEEN ? AND ?
           AND l.source_type NOT IN ('closing', 'closing_reversal')
         GROUP BY a.id, l.cost_center_id
         HAVING amount <> 0
         ORDER BY a.code`,
        [q.from, q.to],
      );
      const centers = db.all<CostCenter>('SELECT * FROM cost_centers ORDER BY code');
      const total = (cc: number | null) =>
        rows.filter((x) => x.cost_center_id === cc).reduce((s, x) => s + (x.type === 'income' ? x.amount : -x.amount), 0);
      return {
        ...q,
        rows,
        centers,
        profit: [...centers.map((c) => ({ cost_center_id: c.id, profit: total(c.id) })), { cost_center_id: null, profit: total(null) }],
      };
    });
  },
};
