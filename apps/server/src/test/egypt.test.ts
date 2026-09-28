import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';
import { egyptSalaryTax, payslip } from '../modules/payroll/engine.js';

/**
 * Egyptian rules, each checked against a worked example.
 *
 * Salary tax (Law 91/2005 art. 8, Law 7/2024), monthly gross 20,000, insurable wage 16,700 (2026 maximum):
 *   employee insurance 11% × 16,700 = 1,837 → taxable 18,163 × 12 = 217,956 − 20,000 exemption = 197,956
 *   → 197,950 (down to 10 pounds): 15,000 × 10% + 15,000 × 15% + 127,950 × 20% = 1,500 + 2,250 + 25,590
 *   = 29,340 a year → 2,445 a month. Employer insurance 18.75% × 16,700 = 3,131.25.
 *
 * Withholding (خصم وإضافة): a supplier bill 10,000 + 14% VAT = 11,400 for services (3%) → 300 withheld on
 * the value before VAT, 11,100 paid; a customer invoice 50,000 + 7,000 VAT, the customer withholds 1%
 * (supplies) → 500, 56,500 received.
 */
describe('Egypt: salary tax, social insurance, withholding', () => {
  let c: TestClient;
  const K = 100;
  let bank: number, sales: number;
  const balance = async (id: number) => {
    const t = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    const r = t.rows.find((x: any) => x.id === id);
    return r ? r.closing_debit - r.closing_credit : 0;
  };

  before(async () => {
    c = await setupCompany({ vatRateBp: 1400 });
    [bank, sales] = await Promise.all(['1120', '4100'].map((x) => acc(c, x)));
  });
  after(() => c.close());

  test('salary tax brackets of Law 7/2024, with the lower brackets falling away above 600,000', () => {
    assert.equal(egyptSalaryTax(197_956 * K), 29_340 * K);
    assert.equal(egyptSalaryTax(40_000 * K), 0);
    assert.equal(egyptSalaryTax(55_000 * K), 1_500 * K);
    // 650,000: the 0% bracket is gone — 55,000 × 10% + 15,000 × 15% + 130,000 × 20% + 200,000 × 22.5% + 250,000 × 25%
    assert.equal(egyptSalaryTax(650_000 * K), (5_500 + 2_250 + 26_000 + 45_000 + 62_500) * K);
    // 1,500,000: 25% up to 1,200,000 and 27.5% above
    assert.equal(egyptSalaryTax(1_500_000 * K), (300_000 + 82_500) * K);
  });

  test('payslip: insurance on the insurable wage between its minimum and maximum, tax after insurance', () => {
    const si = { id: 1, name: 'SI', kind: 'deduction' as const, calc: 'percent_insurable' as const, value: 1100, preTax: true, prorate: true, floor: 2_700 * K, cap: 16_700 * K };
    const tax = { id: 2, name: 'Tax', kind: 'deduction' as const, calc: 'tax' as const, value: 0, preTax: false, prorate: false, exemption: 20_000 * K, taxRule: 'eg_2024' as const };
    const er = { ...si, id: 3, kind: 'employer' as const, value: 1875 };
    const p = payslip({ basicSalary: 20_000 * K, share: 1, components: [si, tax, er], insurableWage: 18_000 * K });
    const line = (id: number) => p.lines.find((l) => l.componentId === id)!.amount;
    assert.equal(line(1), 1_837 * K, 'capped at 16,700');
    assert.equal(line(2), 2_445 * K);
    assert.equal(line(3), 313_125, 'employer 3,131.25');
    const low = payslip({ basicSalary: 2_000 * K, share: 1, components: [si], insurableWage: 2_000 * K });
    assert.equal(low.lines.find((l) => l.componentId === 1)!.amount, 297 * K, 'raised to the 2,700 minimum');
  });

  test('one click sets up Egyptian payroll, and a month posts to its own accounts', async () => {
    const setup = await c.post('/api/payroll/components/egypt', { year: 2026 });
    assert.deepEqual([setup.insurableMin, setup.insurableMax], [2_700 * K, 16_700 * K]);
    assert.equal((await c.raw('POST', '/api/payroll/components/egypt', { year: 2026 })).body.error.code, 'payroll.egypt_exists');
    await c.post('/api/payroll/employees', { name: 'Hany Adel', hireDate: '2025-01-01', basicSalary: 20_000 * K, insurableWage: 16_700 * K });
    const run = (await c.post('/api/payroll/runs', { month: '2026-01', payDate: '2026-01-31' })).id;
    const r = await c.get(`/api/payroll/runs/${run}`);
    assert.deepEqual([r.gross, r.deductions, r.net, r.employer], [20_000 * K, (1_837 + 2_445) * K, (20_000 - 1_837 - 2_445) * K, 313_125]);
    await c.post(`/api/payroll/runs/${run}/post`);
    const code = async (x: string) => balance(await acc(c, x));
    assert.equal(await code('2142'), -2_445 * K, 'salary tax payable');
    assert.equal(await code('2141'), -(1_837 * K + 313_125), 'social insurance payable: both shares');
    assert.equal(await code('5211'), 313_125, 'employer share expensed');
  });

  test('withholding from a supplier: 3% on the value before VAT, the rest paid, due on Form 41', async () => {
    const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Cairo Cleaning Services', taxNumber: '100-200-300', whtType: 'services' })).id;
    const vat = (await c.get('/api/taxes')).find((t: any) => t.code === 'VAT').id;
    const bill = await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-02-10', post: true, lines: [{ description: 'Office cleaning', quantity: 1000, unitPrice: 10_000 * K, taxId: vat, accountId: await acc(c, '5280') }] });
    const s = await c.post('/api/payments/withholding', { partyId: supplier, direction: 'out', allocations: [{ documentId: bill.id, amount: 11_400 * K }] });
    assert.deepEqual([s.type, s.rateBp, s.base, s.amount], ['services', 300, 10_000 * K, 300 * K]);
    await c.post('/api/payments', {
      direction: 'out', date: '2026-02-20', partyId: supplier, accountId: bank, amount: 11_100 * K, post: true,
      withholding: { type: 'services', base: 10_000 * K }, allocations: [{ documentId: bill.id, amount: 11_400 * K }],
    });
    assert.equal((await c.get(`/api/documents/${bill.id}`)).amount_settled, 11_400 * K, 'the bill is fully settled');
    const health = (await c.get('/api/system/health')).find((m: any) => m.module === 'payments');
    assert.equal(health.checks.find((x: any) => x.id === 'allocated').ok, true, 'the withheld tax counts towards the allocation');
    assert.equal(await balance(await acc(c, '2190')), -300 * K);
    const report = await c.get('/api/reports/withholding?from=2026-01-01&to=2026-03-31&side=deducted');
    assert.deepEqual([report.total, report.base, report.ledger.balance, report.rows[0].tax_number], [300 * K, 10_000 * K, 300 * K, '100-200-300']);

    const small = await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-02-11', post: true, lines: [{ description: 'Extra', quantity: 1000, unitPrice: 200 * K, taxId: vat, accountId: await acc(c, '5280') }] });
    const none = await c.post('/api/payments/withholding', { partyId: supplier, direction: 'out', allocations: [{ documentId: small.id, amount: 228 * K }] });
    assert.deepEqual([none.amount, none.belowMinimum], [0, true], 'below 300 pounds nothing is withheld');
  });

  test('withholding by a customer: an advance on the company income tax', async () => {
    const customer = (await c.post('/api/parties', { kind: 'customer', name: 'Delta Hotels', taxNumber: '400-500-600', whtType: 'supplies' })).id;
    const vat = (await c.get('/api/taxes')).find((t: any) => t.code === 'VAT').id;
    const inv = await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-03-01', post: true, lines: [{ description: 'Furniture', quantity: 1000, unitPrice: 50_000 * K, taxId: vat, accountId: sales }] });
    await c.post('/api/payments', {
      direction: 'in', date: '2026-03-15', partyId: customer, accountId: bank, amount: 56_500 * K, post: true,
      withholding: { type: 'supplies', base: 50_000 * K }, allocations: [{ documentId: inv.id, amount: 57_000 * K }],
    });
    assert.equal(await balance(await acc(c, '1180')), 500 * K);
    assert.equal((await c.get(`/api/documents/${inv.id}`)).amount_settled, 57_000 * K);
    const wrong = await c.raw('POST', '/api/payments', { direction: 'in', date: '2026-03-15', partyId: customer, accountId: bank, amount: 10 * K, currency: 'USD', withholding: { type: 'supplies', base: 1_000 * K } });
    assert.equal(wrong.status, 400);
  });
  test('the advisor: VAT without a tax invoice, Form 41 and payroll dues, the tax credit, the reserve', async () => {
    const noTin = (await c.post('/api/parties', { kind: 'supplier', name: 'Street Market' })).id;
    const vat = (await c.get('/api/taxes')).find((t: any) => t.code === 'VAT').id;
    const bill = await c.post('/api/documents', { kind: 'purchase_bill', partyId: noTin, date: '2026-03-20', post: true, lines: [{ description: 'Supplies', quantity: 1000, unitPrice: 1_000 * K, taxId: vat, accountId: await acc(c, '5250') }] });
    const r = await c.get('/api/advisor?asOf=2026-04-10');
    const f = (id: string) => r.findings.find((x: any) => x.id === id);
    assert.equal(f('vat_supplier_no_tin').values.amount, 140 * K, 'input VAT without a tax invoice');
    assert.equal(f('vat_supplier_no_tin').items[0].link, `/purchases/bills/${bill.id}`);
    assert.deepEqual([f('wht_form41_due').values.amount, f('wht_form41_due').values.deadline], [300 * K, '2026-04-30'], 'Form 41 due in April');
    assert.equal(f('wht_credit').values.amount, 500 * K);
    assert.equal(f('payroll_tax_due').values.amount, 2_445 * K);
    assert.equal(f('vat_return_due').values.month, '2026-03');
    assert.equal(f('payroll_insurance_limits'), undefined, '2026 limits are current');
    assert.equal(f('cash_negative'), undefined);
    assert.ok(r.findings.every((x: any, i: number, a: any[]) => i === 0 || ['error', 'warning', 'tip'].indexOf(a[i - 1].severity) <= ['error', 'warning', 'tip'].indexOf(x.severity)), 'most serious first');
    const onBill = await c.get(`/api/advisor/documents/${bill.id}`);
    assert.equal(onBill[0].id, 'vat_supplier_no_tin');
  });

  test('the advisor at a year end: legal reserve 5% of profit up to half the capital, the return deadline', async () => {
    const d = await setupCompany({ vatRateBp: null });
    try {
      const [bank2, capital, sales2] = await Promise.all(['1120', '3100', '4100'].map((x) => acc(d, x)));
      await d.post('/api/journal', { date: '2026-01-01', post: true, lines: [{ accountId: bank2, debit: 1_000_000 * K, credit: 0 }, { accountId: capital, debit: 0, credit: 1_000_000 * K }] });
      await d.post('/api/journal', { date: '2026-06-01', post: true, lines: [{ accountId: bank2, debit: 400_000 * K, credit: 0 }, { accountId: sales2, debit: 0, credit: 400_000 * K }] });
      await d.post('/api/fiscal-years', { startDate: '2027-01-01', endDate: '2027-12-31' }).catch(() => null);
      const r = await d.get('/api/advisor?asOf=2027-02-15');
      const f = (id: string) => r.findings.find((x: any) => x.id === id);
      assert.deepEqual([f('legal_reserve').values.profit, f('legal_reserve').values.amount], [400_000 * K, 20_000 * K]);
      assert.equal(f('income_tax_return').values.deadline, '2027-04-30');
      const ytd = await d.get('/api/advisor?asOf=2026-06-30');
      assert.equal(ytd.findings.find((x: any) => x.id === 'income_tax_provision').values.tax, 90_000 * K, '22.5% of 400,000');
    } finally {
      await d.close();
    }
  });
});
