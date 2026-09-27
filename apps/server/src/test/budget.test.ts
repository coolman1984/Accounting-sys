import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';
import { seedMonths } from '../modules/budget/engine.js';

/**
 * Worked example, months 1–3 of 2026 (EGP):
 *   budget per month: sales 100,000; cost of sales 60,000 (variable); rent 10,000 and salaries 20,000 (fixed)
 *   actual: sales 320,000; cost of sales 195,000; rent 30,000; salaries 66,000
 *   static profit 30,000 → flexible (index 320/300) 38,000 → actual 29,000
 *   activity variance +8,000 (F), flexible-budget variance −9,000 (U), total −1,000 (U)
 * Sales by item (budget: A 300 @ 500 cost 300; B 150 @ 1,000 cost 500; actual: A 330 @ 480, B 120 @ 1,050):
 *   price −600; volume −9,000 = mix −9,000 + quantity 0
 */
describe('budgets and variance analysis', () => {
  let c: TestClient;
  const K = 100;
  let id: number, sales: number, cogs: number, rent: number, salaries: number, bank: number, itemA: number, itemB: number, customer: number;
  const month = (v: number) => Array(12).fill(v * K);

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    [sales, cogs, rent, salaries, bank] = await Promise.all(['4100', '5100', '5220', '5210', '1120'].map((x) => acc(c, x)));
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Buyer' })).id;
    itemA = (await c.post('/api/items', { sku: 'A', nameEn: 'Item A', nameAr: 'صنف أ', kind: 'service', salePrice: 500 * K, incomeAccountId: sales })).id;
    itemB = (await c.post('/api/items', { sku: 'B', nameEn: 'Item B', nameAr: 'صنف ب', kind: 'service', salePrice: 1000 * K, incomeAccountId: sales })).id;
    const je = (date: string, lines: [number, number, number][]) =>
      c.post('/api/journal', { date, post: true, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit: debit * K, credit: credit * K })) });
    // Sales through invoices (so items have actual quantities): Jan A 110 @ 480 …, total A 330 @ 480, B 120 @ 1,050.
    const inv = (date: string, a: number, b: number) =>
      c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date, post: true, lines: [{ itemId: itemA, quantity: a * 1000, unitPrice: 480 * K }, { itemId: itemB, quantity: b * 1000, unitPrice: 1050 * K }] });
    await inv('2026-01-15', 110, 40); // 52,800 + 42,000 = 94,800
    await inv('2026-02-15', 100, 40); // 48,000 + 42,000 = 90,000
    await inv('2026-03-15', 120, 40); // 57,600 + 42,000 = 99,600  → 284,400 total
    // Other revenue to reach 320,000 exactly (a manual sale booked by journal).
    await je('2026-03-20', [[bank, 35_600, 0], [sales, 0, 35_600]]);
    await je('2026-01-31', [[cogs, 70_000, 0], [rent, 10_000, 0], [salaries, 22_000, 0], [bank, 0, 102_000]]);
    await je('2026-02-28', [[cogs, 55_000, 0], [rent, 10_000, 0], [salaries, 22_000, 0], [bank, 0, 87_000]]);
    await je('2026-03-31', [[cogs, 70_000, 0], [rent, 10_000, 0], [salaries, 22_000, 0], [bank, 0, 102_000]]);

    id = (await c.post('/api/budgets', { name: 'Budget 2026', startDate: '2026-01-01' })).id;
    await c.put(`/api/budgets/${id}/lines`, {
      lines: [
        { accountId: sales, amounts: month(100_000) },
        { accountId: cogs, amounts: month(60_000) },
        { accountId: rent, amounts: month(10_000) },
        { accountId: salaries, amounts: month(20_000) },
      ],
    });
    await c.put(`/api/budgets/${id}/sales`, {
      rows: [
        { itemId: itemA, quantities: Array(12).fill(100_000), unitPrice: 500 * K, unitCost: 300 * K },
        { itemId: itemB, quantities: Array(12).fill(50_000), unitPrice: 1000 * K, unitCost: 500 * K },
      ],
    });
  });
  after(() => c.close());

  test('three-column analysis: static, flexible, actual', async () => {
    const v = await c.get(`/api/budgets/${id}/variance?fromMonth=1&toMonth=3`);
    assert.ok(Math.abs(v.activityIndex - 320 / 300) < 1e-9);
    assert.equal(v.totals.staticProfit, 30_000 * K);
    assert.equal(v.totals.flexibleProfit, 38_000 * K);
    assert.equal(v.totals.actualProfit, 29_000 * K);
    assert.equal(v.totals.activityVariance, 8_000 * K);
    assert.equal(v.totals.flexibleVariance, -9_000 * K);
    const line = (a: number) => v.rows.find((r: any) => r.accountId === a);
    assert.equal(line(cogs).flexible, 192_000 * K);
    assert.equal(line(cogs).flexibleVariance, -3_000 * K, 'cost of sales above the flexed budget is unfavourable');
    assert.equal(line(salaries).flexible, 60_000 * K, 'fixed costs do not flex');
    assert.equal(line(salaries).flexibleVariance, -6_000 * K);
    assert.equal(line(sales).totalVariance, 20_000 * K, 'more revenue than planned is favourable');
    assert.equal(v.worst[0].accountId, salaries);
  });

  test('sales price, volume, mix and quantity variances by item', async () => {
    const v = await c.get(`/api/budgets/${id}/sales-variance?fromMonth=1&toMonth=3`);
    const row = (i: number) => v.rows.find((r: any) => r.itemId === i);
    assert.equal(row(itemA).priceVariance, -6_600 * K);
    assert.equal(row(itemA).volumeVariance, 6_000 * K);
    assert.equal(row(itemB).priceVariance, 6_000 * K);
    assert.equal(row(itemB).volumeVariance, -15_000 * K);
    assert.equal(v.totals.priceVariance, -600 * K);
    assert.equal(v.totals.volumeVariance, -9_000 * K);
    assert.equal(v.totals.mixVariance, -9_000 * K);
    assert.equal(v.totals.quantityVariance, 0);
  });

  test('a budget seeded from actuals keeps the pattern or spreads evenly, with an uplift', async () => {
    // Source Apr 2025 – Mar 2026 (all complete); January of the new budget takes January of the source.
    const seasonal = (await c.post('/api/budgets', { name: 'From actuals', startDate: '2027-01-01', seed: { from: '2025-04-01', upliftBp: 1000, pattern: 'seasonal' } })).id;
    const b = await c.get(`/api/budgets/${seasonal}`);
    const s = b.lines.find((l: any) => l.account_id === sales);
    assert.equal(s.amounts[0], Math.round(94_800 * K * 1.1));
    assert.equal(s.amounts[3], 0);
    const even = (await c.post('/api/budgets', { name: 'Even', startDate: '2027-01-01', seed: { from: '2025-04-01', upliftBp: 1000, pattern: 'even' } })).id;
    const e = (await c.get(`/api/budgets/${even}`)).lines.find((l: any) => l.account_id === sales);
    assert.equal(e.amounts.reduce((x: number, y: number) => x + y, 0), 352_000 * K);
    assert.equal(new Set(e.amounts.slice(0, 11)).size, 1, 'even months, remainder in the last');
  });

  test('seeding aligns calendar months and estimates months that are not complete yet', () => {
    const src = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const target = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12'];
    const values = [10, 20, 30, 1, 2, 3, 4, 5, 6, 7, 8, 0];
    const complete = values.map((_, i) => i < 11); // September still running
    const s = seedMonths(values, src, complete, target, 'seasonal');
    assert.equal(s[0], 1, 'January from January');
    assert.equal(s[9], 10, 'October from October');
    assert.equal(s[8], 9, 'the running month gets the average of the complete ones, not zero');
    assert.equal(seedMonths(values, src, complete, target, 'even').reduce((x, y) => x + y, 0), 96 + 9, 'annualised total');
    assert.deepEqual(seedMonths(values, src, values.map(() => false), target, 'seasonal'), Array(12).fill(0));
  });

  test('rules: P&L accounts only, no duplicates, approval locks, reopen and copy', async () => {
    const bad = await c.raw('PUT', `/api/budgets/${id}/lines`, { lines: [{ accountId: bank, amounts: month(1) }] });
    assert.equal(bad.body.error.code, 'budget.pl_only');
    const dup = await c.raw('PUT', `/api/budgets/${id}/lines`, { lines: [{ accountId: rent, amounts: month(1) }, { accountId: rent, amounts: month(1) }] });
    assert.equal(dup.body.error.code, 'budget.duplicate_line');
    await c.post(`/api/budgets/${id}/approve`);
    const locked = await c.raw('PUT', `/api/budgets/${id}/lines`, { lines: [] });
    assert.equal(locked.body.error.code, 'budget.approved');
    const copy = (await c.post('/api/budgets', { name: 'Revision', startDate: '2026-01-01', copyOf: id })).id;
    assert.equal((await c.get(`/api/budgets/${copy}`)).lines.length, 4);
    await c.post(`/api/budgets/${id}/reopen`);
    assert.equal((await c.get(`/api/budgets/${id}`)).status, 'draft');
  });
});
