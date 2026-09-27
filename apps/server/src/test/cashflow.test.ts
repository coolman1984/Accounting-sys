import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';
import { buckets, occurrences, expectedDate, averageDelay, forecast } from '../modules/cashflow/engine.js';

/**
 * Forecast as of Mon 1 Jun 2026, 13 weeks (1 Jun – 30 Aug):
 *   opening bank 100,000
 *   customer Nile paid its March invoice 20 days late → its open 50,000 (due 14 Jun) is expected 4 Jul
 *   customer Delta owes 8,000 due 1 Apr (61 days overdue) → at risk with a 30-day threshold
 *   supplier bill 30,000 due 10 Jun; payroll 20,000 monthly from 25 Jun; rent 5,000 cheque dated 20 Jun
 */
describe('cash flow forecast', () => {
  let c: TestClient;
  const K = 100;
  let bank: number, rent: number, nile: number, delta: number, supplier: number;
  const invoice = (partyId: number, date: string, dueDate: string, amount: number, kind = 'sales_invoice') =>
    c.post('/api/documents', { kind, partyId, date, dueDate, post: true, lines: [{ description: 'Work', quantity: 1000, unitPrice: amount * K }] });

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    [bank, rent] = await Promise.all(['1120', '5220'].map((x) => acc(c, x)));
    const capital = await acc(c, '3100');
    await c.post('/api/journal', { date: '2026-01-01', post: true, lines: [{ accountId: bank, debit: 100_000 * K, credit: 0 }, { accountId: capital, debit: 0, credit: 100_000 * K }] });
    nile = (await c.post('/api/parties', { kind: 'customer', name: 'Nile' })).id;
    delta = (await c.post('/api/parties', { kind: 'customer', name: 'Delta' })).id;
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Cairo Supplies' })).id;
    const march = await invoice(nile, '2026-03-01', '2026-03-31', 10_000);
    await c.post('/api/payments', { direction: 'in', date: '2026-04-20', partyId: nile, accountId: bank, amount: 10_000 * K, allocations: [{ documentId: march.id, amount: 10_000 * K }], post: true });
    await invoice(nile, '2026-05-15', '2026-06-14', 50_000);
    await invoice(delta, '2026-03-01', '2026-04-01', 8_000);
    await invoice(supplier, '2026-05-20', '2026-06-10', 30_000, 'purchase_bill');
    await c.post('/api/cashflow/plan', { name: 'Payroll', direction: 'out', category: 'payroll', amount: 20_000 * K, startDate: '2026-06-25', repeat: 'monthly' });
    await c.post('/api/journal', { date: '2026-06-20', post: true, lines: [{ accountId: rent, debit: 5_000 * K, credit: 0 }, { accountId: bank, debit: 0, credit: 5_000 * K }] });
    await c.put('/api/cashflow/settings', { minCash: 80_000 * K, useHabits: true, doubtfulDays: 30 });
  });
  after(() => c.close());

  test('engine: periods, repeats, expected dates', () => {
    const w = buckets('2026-06-01', 'week', 2);
    assert.deepEqual(w, [{ from: '2026-06-01', to: '2026-06-07' }, { from: '2026-06-08', to: '2026-06-14' }]);
    assert.deepEqual(buckets('2026-06-15', 'month', 2), [{ from: '2026-06-15', to: '2026-06-30' }, { from: '2026-07-01', to: '2026-07-31' }]);
    assert.deepEqual(occurrences({ startDate: '2026-01-31', repeat: 'monthly', endDate: null }, '2026-02-01', '2026-04-30'), ['2026-02-28', '2026-03-31', '2026-04-30'], 'month-end clamps');
    assert.deepEqual(occurrences({ startDate: '2026-06-01', repeat: 'quarterly', endDate: '2026-10-01' }, '2026-06-01', '2026-12-31'), ['2026-06-01', '2026-09-01']);
    assert.deepEqual(occurrences({ startDate: '2026-05-01', repeat: 'once', endDate: null }, '2026-06-01', '2026-12-31'), [], 'a past one-off is gone');
    assert.equal(expectedDate('2026-05-01', 10, '2026-06-01'), '2026-06-01', 'overdue beyond the habit → today');
    assert.equal(averageDelay([{ dueDate: '2026-01-10', paidDate: '2026-01-20', amount: 300 }, { dueDate: '2026-01-10', paidDate: '2026-01-05', amount: 100 }]), 7.5);
    const f = forecast(100, buckets('2026-06-01', 'week', 2), [{ date: '2026-05-01', amount: -150, source: 'payables', label: 'late' }, { date: '2026-07-01', amount: 999, source: 'planned', label: 'later' }], 0);
    assert.equal(f.buckets[0].closing, -50, 'overdue falls into the first week');
    assert.equal(f.firstShortfall, 0);
    assert.equal(f.fundingNeed, 50);
    assert.equal(f.beyond, 999);
  });

  test('13-week forecast with customer habits, doubtful debts, plan and post-dated cheques', async () => {
    const f = await c.get('/api/cashflow/forecast?asOf=2026-06-01&granularity=week');
    assert.equal(f.opening, 110_000 * K, 'capital + March collection');
    assert.equal(f.buckets.length, 13);
    const week = (d: string) => f.buckets.findIndex((b: any) => d >= b.from && d <= b.to);
    const flow = (label: string) => f.buckets.flatMap((b: any) => b.flows).find((x: any) => x.label.startsWith(label));
    assert.equal(flow('Nile').date, '2026-07-04', 'due 14 Jun + 20 days usual delay');
    assert.equal(flow('Cairo Supplies').date, '2026-06-10');
    assert.equal(f.atRiskTotal, 8_000 * K);
    assert.equal(f.totals.receivables, 50_000 * K, 'the doubtful invoice is not counted');
    assert.equal(f.totals.planned, -60_000 * K, 'payroll Jun, Jul, Aug');
    assert.equal(f.totals.booked, -5_000 * K);
    assert.equal(f.buckets[week('2026-06-10')].closing, 80_000 * K);
    assert.equal(f.buckets[week('2026-06-20')].closing, 75_000 * K);
    assert.equal(f.firstShortfall, week('2026-06-20'), 'below the 80,000 minimum after the rent cheque');
    assert.equal(f.closing, (110_000 - 30_000 - 5_000 - 60_000 + 50_000) * K);

    const plain = await c.get('/api/cashflow/forecast?asOf=2026-06-01&granularity=week&habits=0');
    assert.equal(plain.buckets.flatMap((b: any) => b.flows).find((x: any) => x.label.startsWith('Nile')).date, '2026-06-14');
    const noPlan = await c.get('/api/cashflow/forecast?asOf=2026-06-01&granularity=month&exclude=planned,booked');
    assert.equal(noPlan.buckets.length, 12);
    assert.equal(noPlan.totals.planned, 0);
  });

  test('plan rules: one-off ignores the end date, end before start is clamped', async () => {
    const id = (await c.post('/api/cashflow/plan', { name: 'Loan', direction: 'in', amount: 1000, startDate: '2026-07-01', repeat: 'monthly', endDate: '2026-05-01' })).id;
    const row = (await c.get('/api/cashflow/plan')).find((p: any) => p.id === id);
    assert.equal(row.end_date, '2026-07-01');
    await c.del(`/api/cashflow/plan/${id}`);
    const bad = await c.raw('POST', '/api/cashflow/plan', { name: 'x', direction: 'in', amount: 0, startDate: '2026-07-01' });
    assert.equal(bad.status, 400);
  });
});
