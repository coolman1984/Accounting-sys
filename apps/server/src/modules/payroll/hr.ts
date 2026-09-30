import { z } from 'zod';
import { type PayrollPeriodV1 } from '../../eco-contracts/index.js';
import { AppError } from '../../kernel/errors.js';
import { endOfMonth, nowIso } from '../../kernel/dates.js';
import { parse } from '../../kernel/validate.js';
import type { ModuleContext } from '../../kernel/modules.js';
import type { JournalLineInput } from '../ledger/service.js';
import type {} from '../../contracts/eco.js';

/**
 * Payroll calculated by HR-System, booked here (plan 10-MIZAN WP-M5, flow F8). HR owns people and pay; accounting books
 * the entries. hr.payroll_period.v1 carries totals per cost centre and account key — no names. For each period and cost
 * centre ONE balanced journal entry is posted, dated the last day of the period (the cost belongs to the month worked);
 * a `reversed` period reverses them. Nothing is guessed: an unbalanced cost centre or an unknown one refuses the whole
 * event (parked, visible on both sides) and nothing is booked.
 *
 * The keys map to accounts in `payroll_account_map` (editable). Debit keys are costs; credit keys are liabilities. The
 * employer's insurance share is a cost whose other side is the insurance payable; agency labour is a cost whose other
 * side is the suppliers' payable.
 */
export const hrPayrollMigration = {
  id: '003_hr_periods',
  up: `
    CREATE TABLE payroll_account_map (
      account_key TEXT PRIMARY KEY,
      account_id  INTEGER NOT NULL REFERENCES accounts(id)
    );
    CREATE TABLE payroll_hr_period (
      id          INTEGER PRIMARY KEY,
      global_id   TEXT NOT NULL UNIQUE,
      code        TEXT NOT NULL,
      period      TEXT NOT NULL,
      run         INTEGER NOT NULL,
      version     INTEGER NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('booked', 'reversed')),
      entries     TEXT NOT NULL,
      headcount   INTEGER NOT NULL DEFAULT 0,
      hours       TEXT NOT NULL,
      pay_date    TEXT NOT NULL,
      booked_at   TEXT NOT NULL
    );
    ALTER TABLE payroll_settings ADD COLUMN source TEXT NOT NULL DEFAULT 'mizan' CHECK (source IN ('mizan', 'hr'));
  `,
};

export const DEBIT_KEYS = ['gross_earnings', 'overtime', 'night_allowance', 'employer_social_insurance', 'agency_labour'] as const;
export const CREDIT_KEYS = ['employee_social_insurance', 'salary_tax', 'other_deductions', 'net_payable'] as const;
export const ALL_KEYS = [...DEBIT_KEYS, ...CREDIT_KEYS] as const;
type Key = (typeof ALL_KEYS)[number];

const SALARY = { code: '5210', en: 'Salaries & Wages', ar: 'الرواتب والأجور', type: 'expense' as const, subtype: 'operating_expense', parentCode: '52' };
const TEMPLATES: Record<Key, Omit<typeof SALARY, 'type'> & { type: 'expense' | 'liability' }> = {
  gross_earnings: SALARY,
  overtime: SALARY,
  night_allowance: SALARY,
  employer_social_insurance: { code: '5211', en: 'Social Insurance — Employer Share', ar: 'حصة الشركة في التأمينات الاجتماعية', type: 'expense', subtype: 'operating_expense', parentCode: '52' },
  agency_labour: { code: '5213', en: 'Agency Labour', ar: 'عمالة مؤقتة عن طريق مقاولين', type: 'expense', subtype: 'operating_expense', parentCode: '52' },
  employee_social_insurance: { code: '2141', en: 'Social Insurance Payable', ar: 'هيئة التأمينات الاجتماعية - مستحق', type: 'liability', subtype: 'current_liability', parentCode: '21' },
  salary_tax: { code: '2142', en: 'Salary Tax Payable', ar: 'ضريبة كسب العمل المستحقة', type: 'liability', subtype: 'current_liability', parentCode: '21' },
  other_deductions: { code: '2185', en: 'Payroll Deductions Payable', ar: 'استقطاعات رواتب مستحقة', type: 'liability', subtype: 'current_liability', parentCode: '21' },
  net_payable: { code: '2140', en: 'Salaries Payable', ar: 'رواتب مستحقة', type: 'liability', subtype: 'current_liability', parentCode: '21' },
};

interface Period { id: number; global_id: string; version: number; status: 'booked' | 'reversed'; entries: string }

export function hrPayroll(ctx: ModuleContext) {
  const { db, services } = ctx;
  const ledger = () => services.get('ledger');

  /** The account a key posts to: the mapped one, else the chart's own (made on first use). */
  function accountFor(key: Key): number {
    const m = db.get<{ account_id: number }>('SELECT account_id FROM payroll_account_map WHERE account_key = ?', [key]);
    if (m) return m.account_id;
    const id = ledger().ensureAccount(TEMPLATES[key]);
    db.run('INSERT INTO payroll_account_map (account_key, account_id) VALUES (?, ?)', [key, id]);
    return id;
  }
  const payablesAccount = () => ledger().defaultAccount('payable');

  const hasCostCenters = () => !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cost_centers'");
  function costCenterId(code: string): number | null {
    if (!hasCostCenters()) return null;
    const c = db.get<{ id: number; is_active: number }>('SELECT id, is_active FROM cost_centers WHERE code = ?', [code]);
    if (!c || !c.is_active) throw new AppError('payroll.unknown_cost_center', `cost centre ${code} is not known (or is inactive) in accounting`, 409);
    return c.id;
  }

  /** One entry per cost centre: [cost centre code, journal lines]. Throws payroll.unbalanced when a centre does not balance. */
  function build(d: PayrollPeriodV1): { code: string; lines: JournalLineInput[] }[] {
    const byCentre = new Map<string, Map<Key, number>>();
    for (const l of d.lines) {
      const m = byCentre.get(l.cost_center) ?? new Map<Key, number>();
      m.set(l.account_key, (m.get(l.account_key) ?? 0) + l.amount_minor);
      byCentre.set(l.cost_center, m);
    }
    const out: { code: string; lines: JournalLineInput[] }[] = [];
    for (const [code, keys] of [...byCentre].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const cc = costCenterId(code);
      const debit = new Map<number, number>(), credit = new Map<number, number>();
      const add = (m: Map<number, number>, acc: number, amount: number) => amount > 0 && m.set(acc, (m.get(acc) ?? 0) + amount);
      const costLines: JournalLineInput[] = [];
      for (const k of DEBIT_KEYS) {
        const amount = keys.get(k) ?? 0;
        if (amount <= 0) continue;
        costLines.push({ accountId: accountFor(k), debit: amount, credit: 0, costCenterId: cc, description: k });
        if (k === 'employer_social_insurance') add(credit, accountFor('employee_social_insurance'), amount);   // the employer's share is owed to the same authority
        if (k === 'agency_labour') add(credit, payablesAccount(), amount);
      }
      for (const k of CREDIT_KEYS) add(credit, accountFor(k), keys.get(k) ?? 0);
      const debits = costLines.reduce((a, l) => a + l.debit, 0), credits = [...credit.values()].reduce((a, v) => a + v, 0);
      if (debits !== credits) throw new AppError('payroll.unbalanced', `cost centre ${code}: costs ${debits} against liabilities ${credits} (earnings must equal deductions plus net pay)`, 409, { costCenter: code, debits, credits });
      for (const [acc, v] of debit) costLines.push({ accountId: acc, debit: v, credit: 0 });
      out.push({ code, lines: [...costLines, ...[...credit].map(([accountId, v]) => ({ accountId, debit: 0, credit: v }))] });
    }
    return out;
  }

  function apply(d: PayrollPeriodV1): 'applied' | 'unchanged' | 'stale' {
    const cur = db.get<Period>('SELECT id, global_id, version, status, entries FROM payroll_hr_period WHERE global_id = ?', [d.id]);
    if (cur && d.version < cur.version) return 'stale';
    if (cur && d.version === cur.version) return 'unchanged';
    if (d.status === 'reversed') {
      if (!cur || cur.status === 'reversed') {
        if (!cur) db.run("INSERT INTO payroll_hr_period (global_id, code, period, run, version, status, entries, headcount, hours, pay_date, booked_at) VALUES (?, ?, ?, ?, ?, 'reversed', '[]', 0, '{}', ?, ?)", [d.id, d.code, d.period, d.run, d.version, d.pay_date, nowIso()]);
        else db.run('UPDATE payroll_hr_period SET version = ? WHERE id = ?', [d.version, cur.id]);
        return 'applied';
      }
      const reverseOn = endOfMonth(`${d.period}-01`);
      for (const id of JSON.parse(cur.entries) as number[]) ledger().reverseEntry(id, { date: reverseOn, memo: `Reversal of payroll ${d.code}`, sourceType: 'hr_payroll' }, null);
      db.run("UPDATE payroll_hr_period SET status = 'reversed', version = ? WHERE id = ?", [d.version, cur.id]);
      return 'applied';
    }
    if (cur && cur.status === 'booked') throw new AppError('payroll.already_booked', `payroll ${d.code} is already booked: reverse it first`, 409);
    const entries = build(d);                                        // refuses before anything is written
    const date = endOfMonth(`${d.period}-01`);
    const row = cur?.id ?? db.insert('payroll_hr_period', { global_id: d.id, code: d.code, period: d.period, run: d.run, version: d.version, status: 'booked', entries: '[]', headcount: d.headcount, hours: JSON.stringify(d.hours), pay_date: d.pay_date, booked_at: nowIso() });
    const ids = entries.map((e) => ledger().createEntry({ date, reference: `hr:${d.code}`.slice(0, 100), memo: `Payroll ${d.period} run ${d.run} — ${e.code}`, lines: e.lines }, { sourceType: 'hr_payroll', sourceId: row, userId: null }));
    db.run("UPDATE payroll_hr_period SET status = 'booked', version = ?, entries = ?, headcount = ?, hours = ?, pay_date = ?, booked_at = ? WHERE id = ?", [d.version, JSON.stringify(ids), d.headcount, JSON.stringify(d.hours), d.pay_date, nowIso(), row]);
    db.run("UPDATE payroll_settings SET source = 'hr' WHERE id = 1");          // from now on HR calculates pay
    return 'applied';
  }

  return { apply, accountFor, build };
}

export const zAccountMap = z.object({ accountKey: z.enum(ALL_KEYS), accountId: z.number().int().positive() });
export { parse };
