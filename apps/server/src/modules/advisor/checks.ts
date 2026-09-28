import type { ModuleContext } from '../../kernel/modules.js';
import { EG_CORPORATE_TAX_BP, EG_INSURANCE, EG_LEGAL_RESERVE, EG_PERSON_ID_LIMIT, EG_VAT } from '../../contracts/egypt.js';

/**
 * The advisor's checks: Egyptian tax and company law, and the Egyptian Accounting Standards (EAS,
 * based on IFRS). Each check reads the books (never writes) and returns what it found — the web app
 * words it (advisor.checks.<id>.title / body / fix / law) in the reader's language.
 */

export type Severity = 'error' | 'warning' | 'tip';
export type Area = 'vat' | 'wht' | 'payroll' | 'income_tax' | 'standards' | 'books';

export interface FindingItem {
  label: string;
  sub?: string;
  link?: string;
  amount?: number;
}

export interface Finding {
  id: string;
  area: Area;
  severity: Severity;
  /** Values for the words; the keys listed in `money` are amounts in minor units. */
  values: Record<string, string | number>;
  money: string[];
  items: FindingItem[];
}

const DOC_LINK: Record<string, string> = { sales_invoice: '/sales/invoices', sales_credit: '/sales/credit-notes', purchase_bill: '/purchases/bills', purchase_credit: '/purchases/debit-notes' };

const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const endOfMonth = (iso: string) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

export function runChecks(ctx: ModuleContext, asOf: string): Finding[] {
  const { db, services } = ctx;
  const has = (table: string) => !!db.get("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", [table]);
  const unit = 10 ** services.get('settings').company().moneyScale;
  const ledger = services.get('ledger');
  const defaults = ledger.defaultAccounts();
  const fy = ledger.fiscalYears().find((f) => f.start_date <= asOf && f.end_date >= asOf);
  const yearStart = fy?.start_date ?? `${asOf.slice(0, 4)}-01-01`;
  const balance = (ids: (number | null | undefined)[], upTo = asOf) => {
    const list = ids.filter((x): x is number => !!x);
    if (!list.length) return 0;
    return db.get<{ b: number }>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.status = 'posted' AND e.date <= ? AND l.account_id IN (${list.map(() => '?').join(',')})`,
      [upTo, ...list],
    )!.b;
  };
  const out: Finding[] = [];
  const push = (f: Omit<Finding, 'values' | 'money' | 'items'> & Partial<Pick<Finding, 'values' | 'money' | 'items'>>) => out.push({ values: {}, money: [], items: [], ...f });

  const docs = has('documents') && has('parties');

  // ------------------------------------------------------------------ VAT (Law 67/2016)
  if (docs) {
    // Input VAT is deductible only on a tax invoice from a registered supplier.
    const bills = db.all<{ id: number; number: string; date: string; tax: number; name: string }>(
      `SELECT d.id, d.number, d.date, d.base_tax_total AS tax, p.name FROM documents d JOIN parties p ON p.id = d.party_id
        WHERE d.kind = 'purchase_bill' AND d.status = 'posted' AND d.base_tax_total > 0 AND (p.tax_number IS NULL OR trim(p.tax_number) = '')
          AND d.date BETWEEN ? AND ? ORDER BY d.date DESC`,
      [yearStart, asOf],
    );
    if (bills.length) {
      push({
        id: 'vat_supplier_no_tin',
        area: 'vat',
        severity: 'warning',
        values: { count: bills.length, amount: bills.reduce((s, b) => s + b.tax, 0) },
        money: ['amount'],
        items: bills.slice(0, 10).map((b) => ({ label: `${b.number} · ${b.name}`, sub: b.date, link: `/purchases/bills/${b.id}`, amount: b.tax })),
      });
    }
    // Individuals buying for 50,000 or more need their national ID on the e-invoice; companies their tax number.
    const big = db.all<{ id: number; number: string; date: string; total: number; name: string }>(
      `SELECT d.id, d.number, d.date, d.base_total AS total, p.name FROM documents d JOIN parties p ON p.id = d.party_id
        WHERE d.kind = 'sales_invoice' AND d.status = 'posted' AND d.base_total >= ? AND (p.tax_number IS NULL OR trim(p.tax_number) = '')
          AND d.date BETWEEN ? AND ? ORDER BY d.date DESC`,
      [EG_PERSON_ID_LIMIT * unit, yearStart, asOf],
    );
    if (big.length) {
      push({
        id: 'vat_customer_no_id',
        area: 'vat',
        severity: 'warning',
        values: { count: big.length, limit: EG_PERSON_ID_LIMIT * unit },
        money: ['limit'],
        items: big.slice(0, 10).map((b) => ({ label: `${b.number} · ${b.name}`, sub: b.date, link: `/sales/invoices/${b.id}`, amount: b.total })),
      });
    }
    // The monthly return for last month is due by the end of this month.
    const last = addMonths(asOf, -1);
    const vat = db.get<{ output: number; input: number; n: number }>(
      `SELECT COALESCE(SUM(CASE d.kind WHEN 'sales_invoice' THEN d.base_tax_total WHEN 'sales_credit' THEN -d.base_tax_total ELSE 0 END), 0) output,
              COALESCE(SUM(CASE d.kind WHEN 'purchase_bill' THEN d.base_tax_total WHEN 'purchase_credit' THEN -d.base_tax_total ELSE 0 END), 0) input,
              COUNT(*) n
         FROM documents d WHERE d.status = 'posted' AND d.base_tax_total <> 0 AND d.date BETWEEN ? AND ?`,
      [last, endOfMonth(last)],
    )!;
    if (vat.n > 0) {
      push({
        id: vat.output - vat.input >= 0 ? 'vat_return_due' : 'vat_return_credit',
        area: 'vat',
        severity: 'tip',
        values: { month: last.slice(0, 7), output: vat.output, input: vat.input, net: Math.abs(vat.output - vat.input), deadline: endOfMonth(asOf) },
        money: ['output', 'input', 'net'],
        items: [{ label: '', link: `/reports/tax?from=${last}&to=${endOfMonth(last)}` }],
      });
    }
    // Registration is required once annual sales reach 500,000 pounds.
    const registered = has('taxes') && !!db.get('SELECT 1 FROM taxes WHERE is_active = 1 AND rate_bp > 0') && ctx.apps.isEnabled('tax');
    if (!registered) {
      const sales = db.get<{ s: number }>(
        `SELECT COALESCE(SUM(CASE d.kind WHEN 'sales_invoice' THEN d.base_subtotal ELSE -d.base_subtotal END), 0) s FROM documents d
          WHERE d.kind IN ('sales_invoice', 'sales_credit') AND d.status = 'posted' AND d.date > ? AND d.date <= ?`,
        [addMonths(asOf, -12), asOf],
      )!.s;
      if (sales >= EG_VAT.registrationThreshold * unit) {
        push({ id: 'vat_not_registered', area: 'vat', severity: 'warning', values: { sales, threshold: EG_VAT.registrationThreshold * unit }, money: ['sales', 'threshold'] });
      }
    }
  }

  // ------------------------------------------------------------------ withholding (خصم وإضافة)
  if (has('payments') && docs && services.has('tax')) {
    const wht = services.get('tax').withholding();
    if (wht.agent) {
      const missed = db.all<{ id: number; number: string; date: string; name: string; base: number }>(
        `SELECT p.id, p.number, p.date, pa.name,
                (SELECT COALESCE(SUM(a.amount * d.subtotal / d.total), 0) FROM payment_allocations a JOIN documents d ON d.id = a.document_id WHERE a.payment_id = p.id AND d.total > 0) AS base
           FROM payments p JOIN parties pa ON pa.id = p.party_id
          WHERE p.direction = 'out' AND p.party_role = 'supplier' AND p.status = 'posted' AND p.wht_amount = 0 AND p.currency IS NULL
            AND p.date BETWEEN ? AND ? ORDER BY p.date DESC`,
        [yearStart, asOf],
      ).filter((p) => p.base >= wht.minBase);
      if (missed.length) {
        push({
          id: 'wht_not_withheld',
          area: 'wht',
          severity: 'warning',
          values: { count: missed.length, min: wht.minBase },
          money: ['min'],
          items: missed.slice(0, 10).map((p) => ({ label: `${p.number} · ${p.name}`, sub: p.date, link: `/payments/${p.id}`, amount: p.base })),
        });
      }
      const untyped = db.all<{ id: number; name: string; paid: number }>(
        `SELECT pa.id, pa.name, SUM(p.amount) paid FROM payments p JOIN parties pa ON pa.id = p.party_id
          WHERE p.direction = 'out' AND p.party_role = 'supplier' AND p.status = 'posted' AND pa.wht_type IS NULL AND p.date BETWEEN ? AND ?
          GROUP BY pa.id HAVING SUM(p.amount) >= ? ORDER BY paid DESC`,
        [yearStart, asOf, wht.minBase],
      );
      if (untyped.length) {
        push({ id: 'wht_supplier_type', area: 'wht', severity: 'tip', values: { count: untyped.length }, items: untyped.slice(0, 10).map((p) => ({ label: p.name, link: `/suppliers/${p.id}`, amount: p.paid })) });
      }
    }
    // Deducted tax is paid with Form 41 during the month after each quarter (January, April, July, October).
    const due = -balance([defaults.whtPayable]);
    if (due > 0) {
      const m = Number(asOf.slice(5, 7));
      const deadlineMonth = [1, 4, 7, 10].includes(m) ? asOf : addMonths(asOf, [2, 5, 8, 11].includes(m) ? 2 : 1);
      push({ id: 'wht_form41_due', area: 'wht', severity: 'tip', values: { amount: due, deadline: endOfMonth(deadlineMonth) }, money: ['amount'], items: [{ label: '', link: '/reports/withholding?side=deducted' }] });
    }
    const credit = balance([defaults.whtReceivable]);
    if (credit > 0) push({ id: 'wht_credit', area: 'wht', severity: 'tip', values: { amount: credit }, money: ['amount'], items: [{ label: '', link: '/reports/withholding?side=suffered' }] });
  }

  // ------------------------------------------------------------------ payroll
  if (has('pay_components') && has('employees')) {
    const insurable = db.all<{ id: number; name_en: string; floor: number; cap: number }>('SELECT id, name_en, floor, cap FROM pay_components WHERE insurable = 1 AND is_active = 1');
    if (insurable.length) {
      const missing = db.all<{ id: number; code: string; name: string }>("SELECT id, code, name FROM employees WHERE is_active = 1 AND insurable_wage IS NULL AND (end_date IS NULL OR end_date >= ?)", [asOf]);
      if (missing.length) {
        push({ id: 'payroll_no_insurable_wage', area: 'payroll', severity: 'warning', values: { count: missing.length }, items: missing.slice(0, 10).map((e) => ({ label: `${e.code} · ${e.name}`, link: `/payroll/employees/${e.id}` })) });
      }
      const limits = EG_INSURANCE.limits[Number(asOf.slice(0, 4))];
      const stale = limits ? insurable.filter((c) => c.floor !== limits.min * unit || c.cap !== limits.max * unit) : [];
      if (limits && stale.length) {
        push({ id: 'payroll_insurance_limits', area: 'payroll', severity: 'warning', values: { year: asOf.slice(0, 4), min: limits.min * unit, max: limits.max * unit }, money: ['min', 'max'], items: stale.map((c) => ({ label: c.name_en, link: '/payroll/components', amount: c.cap })) });
      }
    }
    const taxAcc = db.all<{ id: number }>("SELECT DISTINCT liability_account_id id FROM pay_components WHERE tax_rule = 'eg_2024' AND liability_account_id IS NOT NULL").map((r) => r.id);
    const taxDue = -balance(taxAcc);
    if (taxDue > 0) push({ id: 'payroll_tax_due', area: 'payroll', severity: 'tip', values: { amount: taxDue }, money: ['amount'] });
    const siAcc = db.all<{ id: number }>('SELECT DISTINCT liability_account_id id FROM pay_components WHERE insurable = 1 AND liability_account_id IS NOT NULL').map((r) => r.id);
    const siDue = -balance(siAcc);
    if (siDue > 0) push({ id: 'payroll_insurance_due', area: 'payroll', severity: 'tip', values: { amount: siDue }, money: ['amount'] });
  }

  // ------------------------------------------------------------------ income tax and the legal reserve
  const pl = (from: string, to: string) =>
    db.get<{ profit: number; tax: number }>(
      `SELECT COALESCE(SUM(CASE WHEN a.type IN ('income', 'expense') AND a.subtype <> 'income_tax' THEN l.credit - l.debit ELSE 0 END), 0) profit,
              COALESCE(SUM(CASE WHEN a.subtype = 'income_tax' THEN l.debit - l.credit ELSE 0 END), 0) tax
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE e.status = 'posted' AND e.date BETWEEN ? AND ? AND e.source_type NOT IN ('closing', 'closing_reversal')`,
      [from, to],
    )!;
  const ytd = pl(yearStart, asOf);
  if (ytd.profit > 0 && ytd.tax === 0) {
    push({ id: 'income_tax_provision', area: 'income_tax', severity: 'tip', values: { profit: ytd.profit, tax: Math.round((ytd.profit * EG_CORPORATE_TAX_BP) / 10000), rate: EG_CORPORATE_TAX_BP / 100 }, money: ['profit', 'tax'] });
  }
  const lastYear = ledger
    .fiscalYears()
    .filter((f) => f.end_date < asOf)
    .at(-1);
  if (lastYear) {
    // Legal persons file the annual return within four months of the year end.
    const returnDue = endOfMonth(addMonths(lastYear.end_date, 4));
    if (asOf <= returnDue) push({ id: 'income_tax_return', area: 'income_tax', severity: 'tip', values: { year: lastYear.name, deadline: returnDue } });
    const last = pl(lastYear.start_date, lastYear.end_date);
    const net = last.profit - last.tax;
    if (net > 0) {
      const capital = -balance([defaults.capital]);
      const reserve = -balance([defaults.legalReserve]);
      const room = Math.max(0, Math.round((capital * EG_LEGAL_RESERVE.capBpOfCapital) / 10000) - reserve);
      const due = Math.min(Math.round((net * EG_LEGAL_RESERVE.shareBp) / 10000), room);
      const done = defaults.legalReserve ? -balance([defaults.legalReserve]) + balance([defaults.legalReserve], lastYear.end_date) : 0;
      if (due > 0 && done <= 0) push({ id: 'legal_reserve', area: 'income_tax', severity: 'tip', values: { year: lastYear.name, profit: net, amount: due }, money: ['profit', 'amount'] });
    }
    if (lastYear.status === 'open' && asOf > endOfMonth(addMonths(lastYear.end_date, 4))) push({ id: 'year_not_closed', area: 'books', severity: 'tip', values: { year: lastYear.name }, items: [{ label: '', link: '/settings?tab=fiscal' }] });
  }

  // ------------------------------------------------------------------ standards (EAS)
  if (docs) {
    // EAS 47 (IFRS 9): receivables long overdue need an expected credit loss.
    const overdue = db.all<{ id: number; number: string; name: string; due_date: string; left: number }>(
      `SELECT d.id, d.number, p.name, d.due_date, d.base_total - d.base_settled AS left FROM documents d JOIN parties p ON p.id = d.party_id
        WHERE d.kind = 'sales_invoice' AND d.status = 'posted' AND d.base_total > d.base_settled AND d.due_date < ? ORDER BY d.due_date`,
      [addDays(asOf, -90)],
    );
    if (overdue.length) {
      push({
        id: 'ecl_overdue',
        area: 'standards',
        severity: 'warning',
        values: { count: overdue.length, amount: overdue.reduce((s, d) => s + d.left, 0) },
        money: ['amount'],
        items: overdue.slice(0, 10).map((d) => ({ label: `${d.number} · ${d.name}`, sub: d.due_date, link: `${DOC_LINK.sales_invoice}/${d.id}`, amount: d.left })),
      });
    }
  }
  // EAS 49 (IFRS 16): rent paid month after month under a long contract is a lease on the balance sheet.
  const rent = db.get<{ months: number; total: number }>(
    `SELECT COUNT(DISTINCT substr(e.date, 1, 7)) months, COALESCE(SUM(l.debit - l.credit), 0) total FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE a.analysis_tag = 'lease' AND e.status = 'posted' AND e.date BETWEEN ? AND ?`,
    [addMonths(asOf, -12), asOf],
  )!;
  if (rent.months >= 6) push({ id: 'lease_rent', area: 'standards', severity: 'tip', values: { months: rent.months, amount: rent.total }, money: ['amount'] });
  // EAS 2: stock is carried at the lower of cost and net realisable value.
  if (has('stock_values') && has('items')) {
    const below = db.all<{ id: number; sku: string; name: string; cost: number; price: number; qty: number }>(
      `SELECT i.id, i.sku, i.name_en name, (v.value * 1000 / v.qty) cost, i.sale_price price, v.qty FROM stock_values v JOIN items i ON i.id = v.item_id
        WHERE v.qty > 0 AND i.sale_price > 0 AND i.sale_price * v.qty < v.value * 1000 ORDER BY (v.value - i.sale_price * v.qty / 1000) DESC`,
    );
    if (below.length) {
      push({
        id: 'inventory_nrv',
        area: 'standards',
        severity: 'warning',
        values: { count: below.length, amount: below.reduce((s, b) => s + Math.round(((b.cost - b.price) * b.qty) / 1000), 0) },
        money: ['amount'],
        items: below.slice(0, 10).map((b) => ({ label: `${b.sku} · ${b.name}`, link: `/inventory/items/${b.id}`, amount: b.cost - b.price })),
      });
    }
  }
  // EAS 10: depreciation is charged every month the asset is available for use.
  if (has('assets') && has('depreciation_runs')) {
    const active = db.get<{ n: number; first: string | null }>("SELECT COUNT(*) n, MIN(start_month) first FROM assets WHERE status = 'active'")!;
    const lastRun = db.get<{ m: string | null }>('SELECT MAX(month) m FROM depreciation_runs')!.m;
    const due = addMonths(asOf, -1).slice(0, 7);
    if (active.n > 0 && active.first && active.first.slice(0, 7) <= due && (!lastRun || lastRun < due)) {
      push({ id: 'depreciation_behind', area: 'standards', severity: 'warning', values: { month: due, last: lastRun ?? '—' }, items: [{ label: '', link: '/fixed-assets/depreciation' }] });
    }
  }

  // ------------------------------------------------------------------ the books
  const negative = db.all<{ id: number; code: string; name_en: string; b: number }>(
    `SELECT a.id, a.code, a.name_en, SUM(l.debit - l.credit) b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE a.subtype IN ('cash', 'bank') AND e.status = 'posted' AND e.date <= ? GROUP BY a.id HAVING SUM(l.debit - l.credit) < 0`,
    [asOf],
  );
  if (negative.length) {
    push({ id: 'cash_negative', area: 'books', severity: 'error', values: { count: negative.length }, items: negative.map((a) => ({ label: `${a.code} · ${a.name_en}`, link: `/reports/general-ledger?accountId=${a.id}`, amount: a.b })) });
  }
  const oldDrafts =
    db.get<{ n: number }>("SELECT COUNT(*) n FROM journal_entries WHERE status = 'draft' AND date < ?", [addDays(asOf, -30)])!.n +
    (docs ? db.get<{ n: number }>("SELECT COUNT(*) n FROM documents WHERE status = 'draft' AND date < ?", [addDays(asOf, -30)])!.n : 0);
  if (oldDrafts) push({ id: 'old_drafts', area: 'books', severity: 'tip', values: { count: oldDrafts } });

  const order: Record<Severity, number> = { error: 0, warning: 1, tip: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Advice about one document, shown on it. */
export function documentChecks(ctx: ModuleContext, id: number): Finding[] {
  const { db, services } = ctx;
  const unit = 10 ** services.get('settings').company().moneyScale;
  const d = db.get<{ kind: string; status: string; base_tax_total: number; base_total: number; tax_number: string | null; country: string | null }>(
    'SELECT d.kind, d.status, d.base_tax_total, d.base_total, p.tax_number, p.country FROM documents d JOIN parties p ON p.id = d.party_id WHERE d.id = ?',
    [id],
  );
  if (!d || d.status === 'void') return [];
  const out: Finding[] = [];
  const noTin = !d.tax_number || !d.tax_number.trim();
  if (d.kind === 'purchase_bill' && d.base_tax_total > 0 && noTin) out.push({ id: 'vat_supplier_no_tin', area: 'vat', severity: 'warning', values: { count: 1, amount: d.base_tax_total }, money: ['amount'], items: [] });
  if (d.kind === 'sales_invoice' && d.base_total >= EG_PERSON_ID_LIMIT * unit && noTin) out.push({ id: 'vat_customer_no_id', area: 'vat', severity: 'warning', values: { count: 1, limit: EG_PERSON_ID_LIMIT * unit }, money: ['limit'], items: [] });
  return out;
}
