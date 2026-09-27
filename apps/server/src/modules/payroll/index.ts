import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { endOfMonth, nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import type { JournalLineInput } from '../ledger/service.js';
import { payslip, workedShare, type Bracket, type Calc, type Component, type Kind, type PayslipLine } from './engine.js';

interface Employee {
  id: number;
  code: string;
  name: string;
  name_alt: string | null;
  national_id: string | null;
  job_title: string | null;
  department: string | null;
  hire_date: string;
  end_date: string | null;
  basic_salary: number;
  cost_center_id: number | null;
  bank_account: string | null;
  payment_method: 'bank' | 'cash';
  is_active: number;
  notes: string | null;
}
interface ComponentRow {
  id: number;
  name_en: string;
  name_ar: string;
  kind: Kind;
  calc: Calc;
  value: number;
  pre_tax: number;
  prorate: number;
  applies_to_all: number;
  cap: number;
  exemption: number;
  brackets: string | null;
  expense_account_id: number | null;
  liability_account_id: number | null;
  is_active: number;
  sort: number;
}
interface Run {
  id: number;
  month: string;
  pay_date: string;
  status: 'draft' | 'posted' | 'paid';
  gross: number;
  deductions: number;
  net: number;
  employer: number;
  entry_id: number | null;
  payment_entry_id: number | null;
  paid_account_id: number | null;
  paid_date: string | null;
}
interface Line {
  id: number;
  run_id: number;
  employee_id: number;
  days: number;
  of_days: number;
  basic: number;
  gross: number;
  deductions: number;
  net: number;
  employer: number;
  bonus: number;
  other_deduction: number;
  note: string | null;
  details: string;
}

function createPayroll({ db, services, apps }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const audit = () => services.get('audit');
  const employee = (id: number) => db.get<Employee>('SELECT * FROM employees WHERE id = ?', [id]) ?? notFound('employee', id);
  const component = (id: number) => db.get<ComponentRow>('SELECT * FROM pay_components WHERE id = ?', [id]) ?? notFound('pay_component', id);
  const run = (id: number) => db.get<Run>('SELECT * FROM payroll_runs WHERE id = ?', [id]) ?? notFound('payroll_run', id);

  // ------------------------------------------------------------ accounts
  type Key = 'salary_expense_account_id' | 'payable_account_id' | 'deductions_account_id' | 'advances_account_id';
  const TEMPLATES: Record<Key, Parameters<ReturnType<typeof ledger>['ensureAccount']>[0]> = {
    salary_expense_account_id: { code: '5210', en: 'Salaries & Wages', ar: 'الرواتب والأجور', type: 'expense', subtype: 'operating_expense', parentCode: '52' },
    payable_account_id: { code: '2140', en: 'Salaries Payable', ar: 'رواتب مستحقة', type: 'liability', subtype: 'current_liability', parentCode: '21' },
    deductions_account_id: { code: '2185', en: 'Payroll Deductions Payable', ar: 'استقطاعات رواتب مستحقة', type: 'liability', subtype: 'current_liability', parentCode: '21' },
    advances_account_id: { code: '1170', en: 'Employee Advances', ar: 'سلف العاملين', type: 'asset', subtype: 'current_asset', parentCode: '11' },
  };
  function account(key: Key): number {
    const cur = db.get<Record<string, number | null>>('SELECT * FROM payroll_settings WHERE id = 1')![key];
    if (cur) return cur;
    const id = ledger().ensureAccount(TEMPLATES[key]);
    db.run(`UPDATE payroll_settings SET ${key} = ? WHERE id = 1`, [id]);
    return id;
  }

  // ---------------------------------------------------------- employees
  const zEmployee = z.object({
    name: z.string().trim().min(1).max(150),
    nameAlt: zOptText(150),
    nationalId: zOptText(50),
    jobTitle: zOptText(100),
    department: zOptText(100),
    hireDate: zDate,
    endDate: zDate.nullish().transform((v) => v ?? null),
    basicSalary: z.number().int().min(0).max(1e13),
    costCenterId: zOptId.transform((v) => v ?? null),
    bankAccount: zOptText(60),
    paymentMethod: z.enum(['bank', 'cash']).default('bank'),
    isActive: z.boolean().default(true),
    notes: zOptText(2000),
    /** Per-employee component values (null value = the component's default); excluded = not for this employee. */
    components: z.array(z.object({ componentId: zId, value: z.number().int().min(0).max(1e13).nullish().transform((v) => v ?? null), excluded: z.boolean().default(false) })).max(100).default([]),
  });
  function writeEmployee(id: number | null, input: z.infer<typeof zEmployee>, userId: number | null): number {
    if (input.endDate && input.endDate < input.hireDate) fail('payroll.end_before_hire', 'The leaving date is before the hiring date');
    if (input.costCenterId) {
      if (!services.has('costCenters') || !apps.isEnabled('co')) fail('co.unavailable', 'Cost centers are not in use');
      services.get('costCenters').assertUsable(input.costCenterId);
    }
    for (const c of input.components) component(c.componentId);
    const row = {
      name: input.name,
      name_alt: input.nameAlt,
      national_id: input.nationalId,
      job_title: input.jobTitle,
      department: input.department,
      hire_date: input.hireDate,
      end_date: input.endDate,
      basic_salary: input.basicSalary,
      cost_center_id: input.costCenterId,
      bank_account: input.bankAccount,
      payment_method: input.paymentMethod,
      is_active: input.isActive ? 1 : 0,
      notes: input.notes,
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let eid = id;
      if (eid == null) eid = db.insert('employees', { ...row, code: services.get('sequences').next('employee'), created_at: nowIso() });
      else db.update('employees', eid, row);
      db.run('DELETE FROM employee_components WHERE employee_id = ?', [eid]);
      for (const c of input.components) db.insert('employee_components', { employee_id: eid, component_id: c.componentId, value: c.value, excluded: c.excluded ? 1 : 0 });
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'employee', entityId: eid, summary: input.name });
      return eid;
    });
  }

  // --------------------------------------------------------- components
  const zBracket = z.object({ upTo: z.number().int().positive().nullish().transform((v) => v ?? null), rateBp: z.number().int().min(0).max(10000) });
  const zComponent = z.object({
    nameEn: z.string().trim().min(1).max(100),
    nameAr: z.string().trim().min(1).max(100),
    kind: z.enum(['earning', 'deduction', 'employer']),
    calc: z.enum(['fixed', 'percent_basic', 'percent_gross', 'tax']),
    value: z.number().int().min(0).max(1e13).default(0),
    preTax: z.boolean().default(false),
    prorate: z.boolean().default(true),
    appliesToAll: z.boolean().default(true),
    cap: z.number().int().min(0).max(1e13).default(0),
    exemption: z.number().int().min(0).max(1e15).default(0),
    brackets: z.array(zBracket).max(20).default([]),
    expenseAccountId: zOptId.transform((v) => v ?? null),
    liabilityAccountId: zOptId.transform((v) => v ?? null),
    isActive: z.boolean().default(true),
    sort: z.number().int().min(0).max(1000).default(0),
  });
  function writeComponent(id: number | null, input: z.infer<typeof zComponent>, userId: number | null): number {
    if (input.calc === 'tax' && input.kind !== 'deduction') fail('payroll.tax_kind', 'Income tax is a deduction');
    if (input.calc === 'tax' && !input.brackets.length) fail('payroll.brackets', 'Enter the tax brackets');
    if (input.calc !== 'fixed' && input.calc !== 'tax' && input.value > 10000 * 10) fail('payroll.rate', 'Rate is too high');
    if (input.calc === 'percent_gross' && input.kind === 'earning') fail('payroll.gross_earning', 'An earning cannot be a share of gross pay');
    const check = (accId: number | null, types: string[]) => {
      if (!accId) return;
      const a = ledger().account(accId);
      if (a.is_group || !types.includes(a.type)) fail('payroll.component_account', `${a.code} cannot be used here`, { code: a.code });
      if (a.subtype === 'receivable' || a.subtype === 'payable') fail('payroll.component_account', `${a.code} needs a party — choose another account`, { code: a.code });
    };
    check(input.expenseAccountId, ['expense']);
    check(input.liabilityAccountId, ['liability', 'asset']);
    const row = {
      name_en: input.nameEn,
      name_ar: input.nameAr,
      kind: input.kind,
      calc: input.calc,
      value: input.value,
      pre_tax: input.preTax ? 1 : 0,
      prorate: input.prorate ? 1 : 0,
      applies_to_all: input.appliesToAll ? 1 : 0,
      cap: input.cap,
      exemption: input.exemption,
      brackets: input.calc === 'tax' ? JSON.stringify(input.brackets) : null,
      expense_account_id: input.kind === 'deduction' ? null : input.expenseAccountId,
      liability_account_id: input.kind === 'earning' ? null : input.liabilityAccountId,
      is_active: input.isActive ? 1 : 0,
      sort: input.sort,
    };
    return db.tx(() => {
      let cid = id;
      if (cid == null) cid = db.insert('pay_components', row);
      else db.update('pay_components', cid, row);
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'pay_component', entityId: cid, summary: input.nameEn });
      return cid;
    });
  }

  /** The components that apply to an employee, with their values for them. */
  function componentsFor(employeeId: number): Component[] {
    const own = new Map(db.all<{ component_id: number; value: number | null; excluded: number }>('SELECT * FROM employee_components WHERE employee_id = ?', [employeeId]).map((r) => [r.component_id, r]));
    return db
      .all<ComponentRow>('SELECT * FROM pay_components WHERE is_active = 1 ORDER BY sort, id')
      .filter((c) => {
        const o = own.get(c.id);
        return o ? !o.excluded : !!c.applies_to_all;
      })
      .map((c) => ({
        id: c.id,
        name: c.name_en,
        kind: c.kind,
        calc: c.calc,
        value: own.get(c.id)?.value ?? c.value,
        preTax: !!c.pre_tax,
        prorate: !!c.prorate,
        cap: c.cap,
        exemption: c.exemption,
        brackets: c.brackets ? (JSON.parse(c.brackets) as Bracket[]) : [],
      }));
  }

  // --------------------------------------------------------------- runs
  function compute(e: Employee, m: string, bonus: number, otherDeduction: number) {
    const w = workedShare(m, e.hire_date, e.end_date);
    const slip = payslip({ basicSalary: e.basic_salary, share: w.share, components: componentsFor(e.id), bonus, otherDeduction });
    return { w, slip };
  }

  function lineRow(runId: number, e: Employee, m: string, bonus: number, otherDeduction: number, note: string | null) {
    const { w, slip } = compute(e, m, bonus, otherDeduction);
    return {
      run_id: runId,
      employee_id: e.id,
      days: w.days,
      of_days: w.ofDays,
      basic: slip.basic,
      gross: slip.gross,
      deductions: slip.deductions,
      net: slip.net,
      employer: slip.employer,
      bonus,
      other_deduction: otherDeduction,
      note,
      details: JSON.stringify(slip.lines),
    };
  }

  function totals(runId: number) {
    db.run(
      `UPDATE payroll_runs SET
         gross = (SELECT COALESCE(SUM(gross), 0) FROM payroll_lines WHERE run_id = :id),
         deductions = (SELECT COALESCE(SUM(deductions), 0) FROM payroll_lines WHERE run_id = :id),
         net = (SELECT COALESCE(SUM(net), 0) FROM payroll_lines WHERE run_id = :id),
         employer = (SELECT COALESCE(SUM(employer), 0) FROM payroll_lines WHERE run_id = :id),
         updated_at = :now
       WHERE id = :id`,
      { id: runId, now: nowIso() },
    );
  }

  const inMonth = (m: string) =>
    db.all<Employee>(`SELECT * FROM employees WHERE is_active = 1 AND hire_date <= ? AND (end_date IS NULL OR end_date >= ?) ORDER BY code`, [endOfMonth(`${m}-01`), `${m}-01`]);

  function createRun(m: string, payDate: string, userId: number | null): number {
    if (db.get('SELECT 1 FROM payroll_runs WHERE month = ?', [m])) conflict('payroll.run_exists', `The payroll for ${m} already exists`, { month: m });
    const list = inMonth(m);
    if (!list.length) fail('payroll.no_employees', 'No employees on the payroll this month');
    return db.tx(() => {
      const id = db.insert('payroll_runs', { month: m, pay_date: payDate, status: 'draft', created_by: userId, created_at: nowIso(), updated_at: nowIso() });
      for (const e of list) db.insert('payroll_lines', lineRow(id, e, m, 0, 0, null));
      totals(id);
      audit().log({ userId, action: 'create', entity: 'payroll_run', entityId: id, summary: m });
      return id;
    });
  }

  const assertDraft = (r: Run) => {
    if (r.status !== 'draft') conflict('payroll.not_draft', 'This payroll is posted — unpost it to change it');
  };

  /** Recompute every line from today's employee data, keeping the month's bonuses and deductions; add new joiners. */
  function recalculate(runId: number, userId: number | null) {
    const r = run(runId);
    assertDraft(r);
    db.tx(() => {
      const old = new Map(db.all<Line>('SELECT * FROM payroll_lines WHERE run_id = ?', [runId]).map((l) => [l.employee_id, l]));
      db.run('DELETE FROM payroll_lines WHERE run_id = ?', [runId]);
      for (const e of inMonth(r.month)) {
        const o = old.get(e.id);
        db.insert('payroll_lines', lineRow(runId, e, r.month, o?.bonus ?? 0, o?.other_deduction ?? 0, o?.note ?? null));
      }
      totals(runId);
      audit().log({ userId, action: 'update', entity: 'payroll_run', entityId: runId, summary: 'recalculated' });
    });
  }

  function adjust(runId: number, lineId: number, input: { bonus: number; otherDeduction: number; note: string | null }, userId: number | null) {
    const r = run(runId);
    assertDraft(r);
    const l = db.get<Line>('SELECT * FROM payroll_lines WHERE id = ? AND run_id = ?', [lineId, runId]) ?? notFound('payroll_line', lineId);
    const e = employee(l.employee_id);
    const row = lineRow(runId, e, r.month, input.bonus, input.otherDeduction, input.note);
    if (row.net < 0) fail('payroll.negative_net', `${e.name}: deductions are more than the pay`, { name: e.name });
    db.tx(() => {
      db.update('payroll_lines', l.id, row);
      totals(runId);
      audit().log({ userId, action: 'update', entity: 'payroll_line', entityId: l.id, summary: e.name });
    });
  }

  /** The month's entry: expenses (by cost center) against net pay, deductions and employer liabilities. */
  function journal(r: Run): JournalLineInput[] {
    const lines = db.all<Line & { cost_center_id: number | null }>(
      'SELECT l.*, e.cost_center_id FROM payroll_lines l JOIN employees e ON e.id = l.employee_id WHERE l.run_id = ?',
      [r.id],
    );
    const comps = new Map(db.all<ComponentRow>('SELECT * FROM pay_components').map((c) => [c.id, c]));
    const byKey = new Map<string, JournalLineInput>();
    const add = (accountId: number, cc: number | null, amount: number, description: string) => {
      if (amount === 0) return;
      const k = `${accountId}:${cc ?? ''}`;
      const cur = byKey.get(k) ?? { accountId, costCenterId: cc, debit: 0, credit: 0, description };
      if (amount > 0) cur.debit += amount;
      else cur.credit += -amount;
      byKey.set(k, cur);
    };
    const salary = account('salary_expense_account_id');
    for (const l of lines) {
      if (l.net < 0) fail('payroll.negative_net', 'A payslip has a negative net pay', { name: String(l.employee_id) });
      for (const d of JSON.parse(l.details) as PayslipLine[]) {
        const c = d.componentId ? comps.get(d.componentId) : null;
        if (d.kind === 'basic' || (d.kind === 'adjustment' && d.amount > 0)) add(salary, l.cost_center_id, d.amount, 'Salaries');
        else if (d.kind === 'earning') add(c?.expense_account_id ?? salary, l.cost_center_id, d.amount, c?.name_en ?? d.name);
        else if (d.kind === 'deduction') add(c?.liability_account_id ?? account('deductions_account_id'), null, -d.amount, c?.name_en ?? d.name);
        else if (d.kind === 'adjustment') add(account('advances_account_id'), null, d.amount, 'Deductions and advances');
        else if (d.kind === 'employer') {
          add(c?.expense_account_id ?? salary, l.cost_center_id, d.amount, c?.name_en ?? d.name);
          add(c?.liability_account_id ?? account('deductions_account_id'), null, -d.amount, c?.name_en ?? d.name);
        }
      }
    }
    add(account('payable_account_id'), null, -r.net, 'Net salaries');
    // Debits and credits on one account (and cost center) are netted to one line.
    return [...byKey.values()]
      .map((l) => {
        const net = l.debit - l.credit;
        return { ...l, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      })
      .filter((l) => l.debit !== 0 || l.credit !== 0);
  }

  function post(runId: number, userId: number | null) {
    const r = run(runId);
    assertDraft(r);
    if (r.gross === 0) fail('payroll.empty', 'There is nothing to post');
    const date = endOfMonth(`${r.month}-01`);
    db.tx(() => {
      const entryId = ledger().createEntry({ date, reference: `PAYROLL ${r.month}`, memo: `Payroll ${r.month}`, lines: journal(r) }, { sourceType: 'payroll', sourceId: r.id, userId });
      db.update('payroll_runs', r.id, { status: 'posted', entry_id: entryId, posted_at: nowIso(), updated_at: nowIso() });
      audit().log({ userId, action: 'post', entity: 'payroll_run', entityId: r.id, summary: r.month });
    });
  }

  function unpost(runId: number, userId: number | null) {
    const r = run(runId);
    if (r.status !== 'posted') conflict('payroll.not_posted', r.status === 'paid' ? 'Undo the payment first' : 'This payroll is not posted');
    db.tx(() => {
      ledger().reverseEntry(r.entry_id!, { date: endOfMonth(`${r.month}-01`), memo: `Unpost payroll ${r.month}` }, userId);
      db.update('payroll_runs', r.id, { status: 'draft', entry_id: null, posted_at: null, updated_at: nowIso() });
      audit().log({ userId, action: 'reverse', entity: 'payroll_run', entityId: r.id, summary: r.month });
    });
  }

  /** Pay the net salaries from one cash or bank account. */
  function pay(runId: number, input: { date: string; accountId: number }, userId: number | null) {
    const r = run(runId);
    if (r.status !== 'posted') conflict('payroll.not_posted', 'Post the payroll before paying it');
    const a = ledger().account(input.accountId);
    if (a.subtype !== 'cash' && a.subtype !== 'bank') fail('payment.account_not_cash', 'Choose a cash or bank account');
    if (a.currency) fail('fx.account_currency', `${a.code} is kept in ${a.currency}`, { code: a.code, currency: a.currency });
    db.tx(() => {
      const entryId = ledger().createEntry(
        {
          date: input.date,
          reference: `PAYROLL ${r.month}`,
          memo: `Salaries paid ${r.month}`,
          lines: [
            { accountId: account('payable_account_id'), debit: r.net, credit: 0, description: 'Net salaries' },
            { accountId: a.id, debit: 0, credit: r.net, description: `Salaries ${r.month}` },
          ],
        },
        { sourceType: 'payroll_payment', sourceId: r.id, userId },
      );
      db.update('payroll_runs', r.id, { status: 'paid', payment_entry_id: entryId, paid_account_id: a.id, paid_date: input.date, updated_at: nowIso() });
      audit().log({ userId, action: 'pay', entity: 'payroll_run', entityId: r.id, summary: r.month });
    });
  }

  function unpay(runId: number, userId: number | null) {
    const r = run(runId);
    if (r.status !== 'paid') conflict('payroll.not_paid', 'This payroll is not paid');
    db.tx(() => {
      ledger().reverseEntry(r.payment_entry_id!, { date: r.paid_date, memo: `Undo salary payment ${r.month}` }, userId);
      db.update('payroll_runs', r.id, { status: 'posted', payment_entry_id: null, paid_account_id: null, paid_date: null, updated_at: nowIso() });
      audit().log({ userId, action: 'reverse', entity: 'payroll_payment', entityId: r.id, summary: r.month });
    });
  }

  return { employee, component, run, zEmployee, writeEmployee, zComponent, writeComponent, componentsFor, compute, createRun, recalculate, adjust, post, unpost, pay, unpay, journal };
}

export const payrollModule: AppModule = {
  id: 'payroll',
  dependsOn: ['ledger'],
  permissions: ['payroll.employees.read', 'payroll.employees.write', 'payroll.runs.read', 'payroll.runs.write', 'payroll.runs.post', 'payroll.settings.manage'],
  apps: [{ id: 'payroll', order: 65, permissions: ['payroll'] }],
  roles: [{ id: 'payroll_officer', permissions: ['payroll.employees.*', 'payroll.runs.read', 'payroll.runs.write'] }],
  sod: [['payroll.employees.write', 'payroll.runs.post']],
  health({ db }) {
    const bad = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM payroll_runs r WHERE r.net <> (SELECT COALESCE(SUM(net), 0) FROM payroll_lines l WHERE l.run_id = r.id)`,
    )!.n;
    return [{ id: 'run_totals', ok: bad === 0, details: { count: bad } }];
  },
  migrations: [
    {
      id: '001_payroll',
      up: `
        CREATE TABLE employees (
          id             INTEGER PRIMARY KEY,
          code           TEXT NOT NULL UNIQUE,
          name           TEXT NOT NULL,
          name_alt       TEXT,
          national_id    TEXT,
          job_title      TEXT,
          department     TEXT,
          hire_date      TEXT NOT NULL,
          end_date       TEXT,
          basic_salary   INTEGER NOT NULL DEFAULT 0 CHECK (basic_salary >= 0),
          cost_center_id INTEGER,
          bank_account   TEXT,
          payment_method TEXT NOT NULL DEFAULT 'bank' CHECK (payment_method IN ('bank', 'cash')),
          is_active      INTEGER NOT NULL DEFAULT 1,
          notes          TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );
        -- Earnings, deductions and employer contributions, with how they are calculated and booked.
        CREATE TABLE pay_components (
          id                   INTEGER PRIMARY KEY,
          name_en              TEXT NOT NULL,
          name_ar              TEXT NOT NULL,
          kind                 TEXT NOT NULL CHECK (kind IN ('earning', 'deduction', 'employer')),
          calc                 TEXT NOT NULL CHECK (calc IN ('fixed', 'percent_basic', 'percent_gross', 'tax')),
          value                INTEGER NOT NULL DEFAULT 0,        -- amount, or bp
          pre_tax              INTEGER NOT NULL DEFAULT 0,
          prorate              INTEGER NOT NULL DEFAULT 1,
          applies_to_all       INTEGER NOT NULL DEFAULT 1,
          cap                  INTEGER NOT NULL DEFAULT 0,        -- ceiling on the base of a percentage (0 = none)
          exemption            INTEGER NOT NULL DEFAULT 0,        -- tax: annual exemption
          brackets             TEXT,                               -- tax: JSON [{upTo, rateBp}]
          expense_account_id   INTEGER REFERENCES accounts(id),
          liability_account_id INTEGER REFERENCES accounts(id),
          is_active            INTEGER NOT NULL DEFAULT 1,
          sort                 INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE employee_components (
          employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          component_id INTEGER NOT NULL REFERENCES pay_components(id),
          value        INTEGER,
          excluded     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (employee_id, component_id)
        );
        CREATE TABLE payroll_runs (
          id               INTEGER PRIMARY KEY,
          month            TEXT NOT NULL UNIQUE,                   -- YYYY-MM
          pay_date         TEXT NOT NULL,
          status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'paid')),
          gross            INTEGER NOT NULL DEFAULT 0,
          deductions       INTEGER NOT NULL DEFAULT 0,
          net              INTEGER NOT NULL DEFAULT 0,
          employer         INTEGER NOT NULL DEFAULT 0,
          entry_id         INTEGER REFERENCES journal_entries(id),
          payment_entry_id INTEGER REFERENCES journal_entries(id),
          paid_account_id  INTEGER REFERENCES accounts(id),
          paid_date        TEXT,
          posted_at        TEXT,
          created_by       INTEGER REFERENCES users(id),
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );
        CREATE TABLE payroll_lines (
          id              INTEGER PRIMARY KEY,
          run_id          INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
          employee_id     INTEGER NOT NULL REFERENCES employees(id),
          days            INTEGER NOT NULL,
          of_days         INTEGER NOT NULL,
          basic           INTEGER NOT NULL,
          gross           INTEGER NOT NULL,
          deductions      INTEGER NOT NULL,
          net             INTEGER NOT NULL,
          employer        INTEGER NOT NULL,
          bonus           INTEGER NOT NULL DEFAULT 0,
          other_deduction INTEGER NOT NULL DEFAULT 0,
          note            TEXT,
          details         TEXT NOT NULL,
          UNIQUE (run_id, employee_id)
        );
        CREATE TABLE payroll_settings (
          id                        INTEGER PRIMARY KEY CHECK (id = 1),
          salary_expense_account_id INTEGER REFERENCES accounts(id),
          payable_account_id        INTEGER REFERENCES accounts(id),
          deductions_account_id     INTEGER REFERENCES accounts(id),
          advances_account_id       INTEGER REFERENCES accounts(id)
        );
        INSERT INTO payroll_settings (id) VALUES (1);
      `,
    },
  ],

  setup(ctx) {
    ctx.db.run("INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES ('employee', 'EMP-', 1, 4)");
  },

  routes(r, ctx) {
    const { db } = ctx;
    const pr = createPayroll(ctx);
    const audit = ctx.services.get('audit');
    const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month as YYYY-MM');

    // ---------------------------------------------------------- employees
    r.get('/payroll/employees', 'payroll.employees.read', () => db.all('SELECT * FROM employees ORDER BY is_active DESC, code'));
    r.get('/payroll/employees/:id', 'payroll.employees.read', ({ params }) => {
      const e = pr.employee(Number(params.id));
      const components = db.all('SELECT component_id, value, excluded FROM employee_components WHERE employee_id = ?', [e.id]);
      const preview = pr.compute(e, today().slice(0, 7), 0, 0);
      const history = db.all(
        `SELECT r.id AS run_id, r.month, r.status, l.gross, l.deductions, l.net FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
         WHERE l.employee_id = ? ORDER BY r.month DESC LIMIT 24`,
        [e.id],
      );
      return { ...e, components, preview: preview.slip, history };
    });
    r.post('/payroll/employees', 'payroll.employees.write', ({ body, user }) => ({ id: pr.writeEmployee(null, parse(pr.zEmployee, body), user.id) }));
    r.put('/payroll/employees/:id', 'payroll.employees.write', ({ params, body, user }) => {
      pr.employee(Number(params.id));
      return { id: pr.writeEmployee(Number(params.id), parse(pr.zEmployee, body), user.id) };
    });
    r.delete('/payroll/employees/:id', 'payroll.employees.write', ({ params, user }) => {
      const e = pr.employee(Number(params.id));
      if (db.get('SELECT 1 FROM payroll_lines WHERE employee_id = ? LIMIT 1', [e.id])) conflict('payroll.employee_paid', 'This employee is on a payroll — set a leaving date instead');
      db.tx(() => {
        db.run('DELETE FROM employees WHERE id = ?', [e.id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'employee', entityId: e.id, summary: e.name });
      });
      return { ok: true };
    });

    // --------------------------------------------------------- components
    r.get('/payroll/components', 'payroll.employees.read', () =>
      db.all<Record<string, unknown> & { brackets: string | null }>('SELECT * FROM pay_components ORDER BY kind, sort, id').map((c) => ({ ...c, brackets: c.brackets ? JSON.parse(c.brackets) : [] })),
    );
    r.post('/payroll/components', 'payroll.settings.manage', ({ body, user }) => ({ id: pr.writeComponent(null, parse(pr.zComponent, body), user.id) }));
    r.put('/payroll/components/:id', 'payroll.settings.manage', ({ params, body, user }) => {
      pr.component(Number(params.id));
      return { id: pr.writeComponent(Number(params.id), parse(pr.zComponent, body), user.id) };
    });

    // ---------------------------------------------------------------- runs
    r.get('/payroll/runs', 'payroll.runs.read', () => db.all(`SELECT r.*, (SELECT COUNT(*) FROM payroll_lines l WHERE l.run_id = r.id) AS employees FROM payroll_runs r ORDER BY r.month DESC`));
    r.get('/payroll/runs/:id', 'payroll.runs.read', ({ params }) => {
      const run = pr.run(Number(params.id));
      const lines = db
        .all<Line & { code: string; name: string; name_alt: string | null; job_title: string | null; department: string | null; bank_account: string | null; payment_method: string; national_id: string | null }>(
          `SELECT l.*, e.code, e.name, e.name_alt, e.job_title, e.department, e.bank_account, e.payment_method, e.national_id
           FROM payroll_lines l JOIN employees e ON e.id = l.employee_id WHERE l.run_id = ? ORDER BY e.code`,
          [run.id],
        )
        .map((l) => ({ ...l, details: JSON.parse(l.details) }));
      const comps = db.all('SELECT id, name_en, name_ar, kind FROM pay_components');
      return { ...run, lines, components: comps, journal: run.status === 'draft' && lines.length ? safeJournal(run) : null };
    });
    const safeJournal = (run: Run) => {
      try {
        return pr.journal(run);
      } catch {
        return null;
      }
    };
    r.post('/payroll/runs', 'payroll.runs.write', ({ body, user }) => {
      const q = parse(z.object({ month: zMonth, payDate: zDate.nullish() }), body);
      return { id: pr.createRun(q.month, q.payDate ?? endOfMonth(`${q.month}-01`), user.id) };
    });
    r.put('/payroll/runs/:id', 'payroll.runs.write', ({ params, body, user }) => {
      const run = pr.run(Number(params.id));
      if (run.status === 'paid') conflict('payroll.not_draft', 'This payroll is paid');
      const q = parse(z.object({ payDate: zDate }), body);
      db.tx(() => {
        db.run('UPDATE payroll_runs SET pay_date = ?, updated_at = ? WHERE id = ?', [q.payDate, nowIso(), run.id]);
        audit.log({ userId: user.id, action: 'update', entity: 'payroll_run', entityId: run.id, summary: q.payDate });
      });
      return { ok: true };
    });
    r.post('/payroll/runs/:id/recalculate', 'payroll.runs.write', ({ params, user }) => (pr.recalculate(Number(params.id), user.id), { ok: true }));
    r.put('/payroll/runs/:id/lines/:lineId', 'payroll.runs.write', ({ params, body, user }) => {
      const q = parse(z.object({ bonus: z.number().int().min(0).max(1e13).default(0), otherDeduction: z.number().int().min(0).max(1e13).default(0), note: zOptText(300) }), body);
      pr.adjust(Number(params.id), Number(params.lineId), q, user.id);
      return { ok: true };
    });
    r.post('/payroll/runs/:id/post', 'payroll.runs.post', ({ params, user }) => (pr.post(Number(params.id), user.id), { ok: true }));
    r.post('/payroll/runs/:id/unpost', 'payroll.runs.post', ({ params, user }) => (pr.unpost(Number(params.id), user.id), { ok: true }));
    r.post('/payroll/runs/:id/pay', 'payroll.runs.post', ({ params, body, user }) => {
      pr.pay(Number(params.id), parse(z.object({ date: zDate, accountId: zId }), body), user.id);
      return { ok: true };
    });
    r.post('/payroll/runs/:id/unpay', 'payroll.runs.post', ({ params, user }) => (pr.unpay(Number(params.id), user.id), { ok: true }));
    r.delete('/payroll/runs/:id', 'payroll.runs.write', ({ params, user }) => {
      const run = pr.run(Number(params.id));
      if (run.status !== 'draft') conflict('payroll.not_draft', 'Only a draft payroll can be deleted');
      db.tx(() => {
        db.run('DELETE FROM payroll_runs WHERE id = ?', [run.id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'payroll_run', entityId: run.id, summary: run.month });
      });
      return { ok: true };
    });
  },
};
