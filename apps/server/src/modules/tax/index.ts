import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { assertApp, conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso, today } from '../../kernel/dates.js';
import { parse, zBp, zDate, zOptId } from '../../kernel/validate.js';
import { WHT_TYPES, type Tax, type TaxService, type WhtSettings } from '../../contracts/tax.js';

const zTax = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  rateBp: zBp,
  scope: z.enum(['sales', 'purchases', 'both']).default('both'),
  salesAccountId: zOptId.transform((v) => v ?? null),
  purchaseAccountId: zOptId.transform((v) => v ?? null),
  isActive: z.boolean().default(true),
});

/**
 * Tax (VAT): tax codes with their output / input accounts, and the VAT
 * summary for the return. The `taxes` table itself was created by the
 * catalog's first migration (items point at it); this module owns its rules.
 */
export const taxModule: AppModule = {
  id: 'tax',
  dependsOn: ['ledger', 'catalog'],
  permissions: ['tax.codes.read', 'tax.codes.write', 'tax.reports.read'],
  apps: [{ id: 'tax', order: 15, permissions: ['tax'] }],

  setup(ctx) {
    const { db, services, events } = ctx;
    const service: TaxService = {
      get: (id) => db.get<Tax>('SELECT * FROM taxes WHERE id = ?', [id]) ?? notFound('tax', id),
      withholding() {
        const unit = 10 ** services.get('settings').company().moneyScale;
        // The executive regulations' rates: 1% supplies and contracting, 3% services, 5% commissions; 300 EGP minimum. Editable.
        const defaults: WhtSettings = { agent: true, minBase: 300 * unit, rates: { supplies: 100, contracting: 100, services: 300, commissions: 500 } };
        const stored = services.get('settings').get<Partial<WhtSettings>>('withholding', {});
        return { ...defaults, ...stored, rates: { ...defaults.rates, ...(stored.rates ?? {}) } };
      },
    };
    services.provide('tax', service);

    // First-run: the VAT rate chosen in the setup wizard.
    events.on('system.setup', (s) => {
      if (s.vatRateBp == null) return;
      const d = services.get('ledger').defaultAccounts();
      const pct = s.vatRateBp / 100;
      db.insert('taxes', {
        code: 'VAT',
        name_en: `VAT ${pct}%`,
        name_ar: `ضريبة القيمة المضافة ${pct}٪`,
        rate_bp: s.vatRateBp,
        scope: 'both',
        sales_account_id: d.vatOutput,
        purchase_account_id: d.vatInput,
        created_at: nowIso(),
      });
    });
  },

  routes(r, { db, services, apps }) {
    const audit = services.get('audit');
    const ledger = services.get('ledger');
    const tax = services.get('tax');

    const postable = (id: number | null, label: string) => {
      if (id == null) return;
      const a = ledger.account(id);
      if (a.is_group) fail('account.group_not_allowed', `${label}: choose a posting account, not a group`);
    };

    // Reference data: whoever writes invoices or bills picks a tax code, so any signed-in user may list them.
    r.get('/taxes', 'auth', () => {
      assertApp(apps, 'tax');
      return db.all<Tax>('SELECT * FROM taxes ORDER BY code');
    });

    const taxRow = (i: z.infer<typeof zTax>) => ({
      code: i.code,
      name_en: i.nameEn,
      name_ar: i.nameAr,
      rate_bp: i.rateBp,
      scope: i.scope,
      sales_account_id: i.salesAccountId,
      purchase_account_id: i.purchaseAccountId,
      is_active: i.isActive,
    });

    const checkTax = (i: z.infer<typeof zTax>) => {
      if (i.rateBp > 0 && i.scope !== 'purchases' && !i.salesAccountId) fail('tax.account_required', 'Choose the output tax account');
      if (i.rateBp > 0 && i.scope !== 'sales' && !i.purchaseAccountId) fail('tax.account_required', 'Choose the input tax account');
      postable(i.salesAccountId, 'Output tax account');
      postable(i.purchaseAccountId, 'Input tax account');
    };

    r.post('/taxes', 'tax.codes.write', ({ body, user }) => {
      const input = parse(zTax, body);
      checkTax(input);
      if (db.get('SELECT 1 FROM taxes WHERE code = ?', [input.code])) conflict('tax.duplicate_code', 'Tax code already exists');
      return db.tx(() => {
        const id = db.insert('taxes', { ...taxRow(input), created_at: nowIso() });
        audit.log({ userId: user.id, action: 'create', entity: 'tax', entityId: id, summary: input.code });
        return { id };
      });
    });

    r.put('/taxes/:id', 'tax.codes.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const cur = tax.get(id);
      const input = parse(zTax, body);
      checkTax(input);
      const dup = db.get<{ id: number }>('SELECT id FROM taxes WHERE code = ?', [input.code]);
      if (dup && dup.id !== id) conflict('tax.duplicate_code', 'Tax code already exists');
      db.tx(() => {
        // Posted documents keep their own copy of the rate, so changing it only affects new documents.
        db.update('taxes', id, taxRow(input));
        audit.log({ userId: user.id, action: 'update', entity: 'tax', entityId: id, data: { before: cur, after: input } });
      });
      return { ok: true };
    });

    // ------------------------------------------------------------ withholding (خصم وإضافة)
    const zWht = z.object({
      agent: z.boolean(),
      minBase: z.number().int().min(0).max(1e13),
      rates: z.object(Object.fromEntries(WHT_TYPES.map((k) => [k, zBp])) as Record<(typeof WHT_TYPES)[number], typeof zBp>),
    });
    r.get('/tax/withholding', 'auth', () => (assertApp(apps, 'tax'), tax.withholding()));
    r.put('/tax/withholding', 'tax.codes.write', ({ body, user }) => {
      const input = parse(zWht, body);
      services.get('settings').set('withholding', input);
      audit.log({ userId: user.id, action: 'update', entity: 'withholding_settings', data: input });
      return { ok: true };
    });

    /**
     * Withholding report. "deducted": what the company deducted from suppliers (Form 41, due quarterly);
     * "suffered": what customers deducted from the company (a credit against its income tax).
     */
    r.get('/reports/withholding', 'tax.reports.read', ({ query }) => {
      const t = today();
      const q = parse(
        z.object({ from: zDate.default(t.slice(0, 4) + '-01-01'), to: zDate.default(t), side: z.enum(['deducted', 'suffered']).default('deducted') }),
        query,
      );
      if (!services.has('payments')) return { ...q, rows: [], byType: [], total: 0, base: 0, ledger: null };
      const rows = db.all<{ id: number; number: string; date: string; party_id: number; party_name: string; tax_number: string | null; wht_type: string; wht_base: number; wht_rate_bp: number; wht_amount: number }>(
        `SELECT p.id, p.number, p.date, p.party_id, pa.name AS party_name, pa.tax_number, p.wht_type, p.wht_base, p.wht_rate_bp, p.wht_amount
           FROM payments p JOIN parties pa ON pa.id = p.party_id
          WHERE p.status = 'posted' AND p.wht_amount > 0 AND p.direction = ? AND p.date BETWEEN ? AND ?
          ORDER BY p.date, p.number`,
        [q.side === 'deducted' ? 'out' : 'in', q.from, q.to],
      );
      const byType = WHT_TYPES.map((type) => {
        const r = rows.filter((x) => x.wht_type === type);
        return { type, count: r.length, base: r.reduce((s, x) => s + x.wht_base, 0), amount: r.reduce((s, x) => s + x.wht_amount, 0) };
      }).filter((x) => x.count > 0);
      // What the books hold on the withholding account at the end of the period (to reconcile).
      const key = q.side === 'deducted' ? 'whtPayable' : 'whtReceivable';
      const accId = ledger.defaultAccounts()[key];
      const bal = accId ? db.get<{ b: number }>(`SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.status = 'posted' AND e.date <= ?`, [accId, q.to])!.b : null;
      return {
        ...q,
        rows,
        byType,
        base: rows.reduce((s, x) => s + x.wht_base, 0),
        total: rows.reduce((s, x) => s + x.wht_amount, 0),
        ledger: accId ? { accountId: accId, balance: q.side === 'deducted' ? -bal! : bal } : null,
      };
    });

    /** VAT summary for the return: output tax on sales less input tax on purchases. */
    r.get('/reports/tax-summary', 'tax.reports.read', ({ query }) => {
      const t = today();
      const fy = ledger.fiscalYears().find((f) => f.start_date <= t && f.end_date >= t);
      const def = fy ? { from: fy.start_date, to: fy.end_date } : { from: t.slice(0, 4) + '-01-01', to: t.slice(0, 4) + '-12-31' };
      const q = parse(z.object({ from: zDate.default(def.from), to: zDate.default(def.to) }), query);
      // Invoices and bills exist only with the billing engine (AR / AP); without it there is nothing to sum.
      if (!services.has('documents')) return { ...q, rows: [], output: 0, input: 0, net: 0 };
      const rows = db.all<{ tax_id: number; code: string; name_en: string; name_ar: string; rate_bp: number; side: string; net: number; tax: number }>(
        `SELECT t.id AS tax_id, t.code, t.name_en, t.name_ar, l.tax_rate_bp AS rate_bp,
                CASE WHEN d.kind LIKE 'sales_%' THEN 'sales' ELSE 'purchases' END AS side,
                SUM(CASE WHEN d.kind IN ('sales_invoice', 'purchase_bill') THEN l.base_net ELSE -l.base_net END) AS net,
                SUM(CASE WHEN d.kind IN ('sales_invoice', 'purchase_bill') THEN l.base_tax ELSE -l.base_tax END) AS tax
         FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN taxes t ON t.id = l.tax_id
         WHERE d.status = 'posted' AND d.date BETWEEN ? AND ?
         GROUP BY t.id, l.tax_rate_bp, side ORDER BY t.code, side`,
        [q.from, q.to],
      );
      const output = rows.filter((x) => x.side === 'sales').reduce((s, x) => s + x.tax, 0);
      const input = rows.filter((x) => x.side === 'purchases').reduce((s, x) => s + x.tax, 0);
      return { ...q, rows, output, input, net: output - input };
    });
  },
};
