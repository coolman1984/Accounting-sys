import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';
import { bracketTax, payslip, workedShare } from '../modules/payroll/engine.js';

/**
 * March 2026 (31 days). Components: transport 500 (fixed, prorated), employee insurance 11 % of basic
 * (before tax), salary tax on annual brackets (exemption 20,000; 0 % to 40,000, 10 % to 60,000,
 * 20 % above), employer insurance 18.75 % of basic. Amounts are kept to the piaster.
 *   Ahmed: basic 10,000, full month → gross 10,500, insurance 1,100,
 *          tax on (10,500 − 1,100) × 12 − 20,000 = 92,800 → 8,560 a year → 713.33 → net 8,686.67; employer 1,875
 *   Sara:  basic 6,200, hired 16 March → 16/31: basic 3,200, transport 258.06, gross 3,458.06, insurance 352,
 *          no tax → net 3,106.06; employer 600. With a 200 bonus: gross 3,658.06, net 3,306.06.
 */
describe('payroll: employees, components, monthly run, posting and payment', () => {
  let c: TestClient;
  const K = 100;
  let bank: number, salaries: number, runId: number;
  const balance = async (id: number) => {
    const t = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(t.balanced, true);
    const r = t.rows.find((x: any) => x.id === id);
    return r ? r.closing_debit - r.closing_credit : 0;
  };

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    [bank, salaries] = await Promise.all(['1120', '5210'].map((x) => acc(c, x)));
    const capital = await acc(c, '3100');
    await c.post('/api/journal', { date: '2026-01-01', post: true, lines: [{ accountId: bank, debit: 100_000 * K, credit: 0 }, { accountId: capital, debit: 0, credit: 100_000 * K }] });
  });
  after(() => c.close());

  test('engine: worked days, brackets, payslip', () => {
    assert.deepEqual(workedShare('2026-03', '2026-03-16', null), { days: 16, ofDays: 31, share: 16 / 31 });
    assert.equal(workedShare('2026-03', '2026-04-01', null).share, 0);
    assert.equal(workedShare('2026-02', '2025-01-01', '2026-02-14').days, 14);
    assert.equal(bracketTax(92_800, [{ upTo: 40_000, rateBp: 0 }, { upTo: 60_000, rateBp: 1000 }, { upTo: null, rateBp: 2000 }]), 8_560);
    const p = payslip({ basicSalary: 10_000, share: 1, components: [{ id: 1, name: 'Ins', kind: 'deduction', calc: 'percent_basic', value: 1100, preTax: true, prorate: false, cap: 8_000 }] });
    assert.equal(p.deductions, 880, 'the insurance base is capped');
  });

  test('a monthly run computes every payslip', async () => {
    const comp = (body: Record<string, unknown>) => c.post('/api/payroll/components', body);
    await comp({ nameEn: 'Transport', nameAr: 'بدل انتقال', kind: 'earning', calc: 'fixed', value: 500 * K });
    await comp({ nameEn: 'Social insurance', nameAr: 'تأمينات', kind: 'deduction', calc: 'percent_basic', value: 1100, preTax: true });
    await comp({ nameEn: 'Salary tax', nameAr: 'ضريبة كسب العمل', kind: 'deduction', calc: 'tax', exemption: 20_000 * K, brackets: [{ upTo: 40_000 * K, rateBp: 0 }, { upTo: 60_000 * K, rateBp: 1000 }, { upTo: null, rateBp: 2000 }] });
    await comp({ nameEn: 'Employer insurance', nameAr: 'حصة صاحب العمل', kind: 'employer', calc: 'percent_basic', value: 1875 });
    const bad = await c.raw('POST', '/api/payroll/components', { nameEn: 'x', nameAr: 'x', kind: 'earning', calc: 'tax', brackets: [] });
    assert.equal(bad.body.error.code, 'payroll.tax_kind');
    await c.post('/api/payroll/employees', { name: 'Ahmed', hireDate: '2025-01-01', basicSalary: 10_000 * K });
    await c.post('/api/payroll/employees', { name: 'Sara', hireDate: '2026-03-16', basicSalary: 6_200 * K });
    await c.post('/api/payroll/employees', { name: 'Omar', hireDate: '2026-05-01', basicSalary: 9_000 * K });
    runId = (await c.post('/api/payroll/runs', { month: '2026-03', payDate: '2026-04-01' })).id;
    const run = await c.get(`/api/payroll/runs/${runId}`);
    assert.equal(run.lines.length, 2, 'Omar starts in May');
    const line = (n: string) => run.lines.find((l: any) => l.name === n);
    assert.equal(line('Ahmed').gross, 10_500 * K);
    assert.equal(line('Ahmed').deductions, 181_333);
    assert.equal(line('Ahmed').net, 868_667);
    assert.equal(line('Ahmed').employer, 1_875 * K);
    assert.equal(line('Sara').days, 16);
    assert.equal(line('Sara').basic, 3_200 * K);
    assert.equal(line('Sara').gross, 345_806);
    assert.equal(line('Sara').net, 310_606);
    assert.equal(run.net, 868_667 + 310_606);
    const dup = await c.raw('POST', '/api/payroll/runs', { month: '2026-03' });
    assert.equal(dup.body.error.code, 'payroll.run_exists');
    await c.put(`/api/payroll/runs/${runId}/lines/${line('Sara').id}`, { bonus: 200 * K, note: 'Launch bonus' });
    const after = await c.get(`/api/payroll/runs/${runId}`);
    assert.equal(after.lines.find((l: any) => l.name === 'Sara').net, 330_606);
    assert.equal(after.net, 868_667 + 330_606);
  });

  test('posting books expenses against net pay and deductions; paying clears net pay', async () => {
    await c.post(`/api/payroll/runs/${runId}/post`);
    const settings = c.app.kernel.db.get<{ payable_account_id: number; deductions_account_id: number }>('SELECT * FROM payroll_settings WHERE id = 1')!;
    assert.equal(await balance(salaries), 1_320_000 + 75_806 + 20_000 + 247_500, 'basic + transport + bonus + employer insurance');
    assert.equal(await balance(settings.deductions_account_id), -(145_200 + 71_333 + 247_500), 'insurance + tax + employer insurance');
    assert.equal(await balance(settings.payable_account_id), -(868_667 + 330_606));
    const edit = await c.raw('PUT', `/api/payroll/runs/${runId}/lines/1`, { bonus: 1 });
    assert.equal(edit.body.error.code, 'payroll.not_draft');
    await c.post(`/api/payroll/runs/${runId}/pay`, { date: '2026-04-01', accountId: bank });
    assert.equal(await balance(settings.payable_account_id), 0);
    assert.equal(await balance(bank), 100_000 * K - (868_667 + 330_606));
    const unpost = await c.raw('POST', `/api/payroll/runs/${runId}/unpost`);
    assert.equal(unpost.body.error.code, 'payroll.not_posted');
    await c.post(`/api/payroll/runs/${runId}/unpay`);
    await c.post(`/api/payroll/runs/${runId}/unpost`);
    assert.equal(await balance(salaries), 0);
    assert.equal(await balance(bank), 100_000 * K);
  });
});
