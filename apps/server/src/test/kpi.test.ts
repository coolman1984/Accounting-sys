import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setClock } from '../kernel/dates.js';
import { setupCompany, type TestClient } from './helpers.js';

/** The KPI pack and the executive S&OP view (WP-M6), on hand-calculated numbers. */
describe('KPI pack and executive S&OP', () => {
  let c: TestClient;
  const K = 100;
  const U = 1000;
  let customer: number, tv: number, radio: number, version: number;

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    // the story is in October 2026: the clock stands in early November so October is over (a new sign-in, sessions follow the clock)
    setClock({ now: () => new Date('2026-11-05T09:00:00') });
    c.cookie = await c.login('admin', 'password123');
    const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Parts' })).id;
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'B.TECH' })).id;
    tv = (await c.post('/api/items', { sku: 'TV55', nameEn: 'TV 55"', nameAr: 'تلفزيون 55', kind: 'product', salePrice: 15_000 * K, purchasePrice: 10_000 * K })).id;
    radio = (await c.post('/api/items', { sku: 'RD1', nameEn: 'Radio', nameAr: 'راديو', kind: 'product', salePrice: 1_000 * K, purchasePrice: 600 * K })).id;
    await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-06-01', post: true, lines: [{ itemId: tv, quantity: 200 * U, unitPrice: 10_000 * K }, { itemId: radio, quantity: 200 * U, unitPrice: 600 * K }] });
    // The plan agreed in cycle 2026-09 for October: 40 TVs and 15 radios.
    const cycle = (await c.post('/api/sop/cycles', { period: '2026-09' })).id;
    version = (await c.post(`/api/sop/cycles/${cycle}/versions`, { baselineMonths: 1 })).id;
    await c.put(`/api/sop/versions/${version}/lines`, { lines: [{ itemId: tv, month: '2026-10', qty: 40 * U }, { itemId: radio, month: '2026-10', qty: 15 * U }, { itemId: radio, month: '2026-11', qty: 5 * U }] });
    await c.post(`/api/sop/versions/${version}/approve`);
    // What was really invoiced in October: 30 TVs and 20 radios.
    await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-10-10', post: true, lines: [{ itemId: tv, quantity: 30 * U, unitPrice: 15_000 * K }, { itemId: radio, quantity: 20 * U, unitPrice: 1_000 * K }] });
  });
  after(async () => {
    setClock();
    await c.close();
  });

  test('forecast accuracy and bias of a month, against the plan of the month before', async () => {
    const pack = await c.get('/api/kpi/pack?month=2026-10');
    // errors: TV |30-40| = 10, radio |20-15| = 5 -> 15 of 50 sold = 30 % wrong -> 70 % accurate; plan 55 against 50 sold -> +10 % bias (too optimistic)
    assert.equal(pack.forecast.accuracy_bp, 7000);
    assert.equal(pack.forecast.bias_bp, 1000);
    assert.equal(pack.forecast.plan_qty, 55 * U);
    assert.equal(pack.forecast.actual_qty, 50 * U);
    assert.deepEqual(pack.forecast.basis, { period: '2026-09', version_id: version, lag_months: 1 });
    assert.deepEqual(pack.items.map((i: any) => [i.sku, i.plan_qty, i.actual_qty, i.error_qty]), [['TV55', 40 * U, 30 * U, 10 * U], ['RD1', 15 * U, 20 * U, 5 * U]]);
    // sales against the plan, at the plan price: (30-40) TVs at 15 000 and (20-15) radios at 1 000
    assert.equal(pack.revenue_vs_plan, -10 * 15_000 * K + 5 * 1_000 * K);
  });

  test('the plan is never read from the wrong month, and an unmeasurable figure is null, not 100 %', async () => {
    const none = await c.get('/api/kpi/pack?month=2026-12'); // no plan agreed in 2026-11, and nothing sold
    assert.equal(none.forecast.accuracy_bp, null);
    assert.equal(none.forecast.bias_bp, null);
    assert.equal(none.forecast.basis, null);
    assert.equal(none.service.otd_bp, null);
    assert.equal(none.service.otif_bp, null);
    assert.equal(none.revenue_vs_plan, null);
    const bad = await c.raw('GET', '/api/kpi/pack?month=2026-13');
    assert.equal(bad.status, 400);
  });

  test('delivery service level of the month: on time, in full and fill rate', async () => {
    // two lines due in October: one delivered on time in full, one delivered late and only in part
    const so = (await c.post('/api/sales/orders', { customerId: customer, orderDate: '2026-10-01', confirm: true, lines: [
      { itemId: tv, quantity: 10 * U, requestedDate: '2026-10-15' }, { itemId: radio, quantity: 10 * U, requestedDate: '2026-10-15' }] })).id;
    const o = await c.get(`/api/sales/orders/${so}`);
    await c.post('/api/sales/deliveries', { soId: so, date: '2026-10-14', post: true, lines: [{ soLineId: o.lines[0].id, qty: 10 * U }] });
    await c.post('/api/sales/deliveries', { soId: so, date: '2026-10-20', post: true, lines: [{ soLineId: o.lines[1].id, qty: 4 * U }] });
    const pack = await c.get('/api/kpi/pack?month=2026-10');
    assert.equal(pack.service.lines_measured, 2);
    assert.equal(pack.service.otd_bp, 5000, 'one of two lines delivered by its date');
    assert.equal(pack.service.otif_bp, 5000);
    assert.equal(pack.service.fill_rate_bp, 7000, '14 of 20 delivered');
  });

  test('a month with a plan but no sales is unmeasured, and a line not yet due is not late', async () => {
    // the plan agreed in cycle 2026-10 for November is 5 radios; nothing has been invoiced in November
    const cycle = (await c.post('/api/sop/cycles', { period: '2026-10' })).id;
    const v = (await c.post(`/api/sop/cycles/${cycle}/versions`, { baselineMonths: 1 })).id;
    await c.put(`/api/sop/versions/${v}/lines`, { lines: [{ itemId: radio, month: '2026-11', qty: 5 * U }] });
    await c.post(`/api/sop/versions/${v}/approve`);
    // and a line due on the 20th, which is still in the future on the 5th
    await c.post('/api/sales/orders', { customerId: customer, orderDate: '2026-11-02', confirm: true, lines: [{ itemId: radio, quantity: 3 * U, requestedDate: '2026-11-20' }] });
    const pack = await c.get('/api/kpi/pack?month=2026-11');
    assert.equal(pack.forecast.plan_qty, 5 * U);
    assert.equal(pack.forecast.actual_qty, 0);
    assert.equal(pack.forecast.accuracy_bp, null, 'nothing sold: there is nothing to be accurate about');
    assert.equal(pack.forecast.bias_bp, null);
    assert.equal(pack.service.lines_measured, 0, 'not due yet, so not late');
    assert.equal(pack.service.otif_bp, null);
  });

  test('executive view: demand, supply and budget in money, and the five biggest shortfalls with their cause', async () => {
    await c.put('/api/sop/supply', { rows: [
      { itemId: tv, month: '2026-10', plannedQty: 25 * U, constraint: 'material', source: 'gmes' },
      { itemId: radio, month: '2026-10', plannedQty: 15 * U, constraint: 'none', source: 'gmes' }] });
    const ex = await c.get(`/api/sop/versions/${version}/executive`);
    const oct = ex.months.find((m: any) => m.month === '2026-10');
    assert.equal(oct.demand_value, 40 * 15_000 * K + 15 * 1_000 * K);
    assert.equal(oct.supply_gap_value, -15 * 15_000 * K, 'the TVs are 15 short, the radios are covered');
    assert.equal(ex.top_constraints.length, 1, 'only the shortfalls are listed');
    assert.deepEqual(ex.top_constraints[0], { item_id: tv, sku: 'TV55', name_en: 'TV 55"', name_ar: 'تلفزيون 55', month: '2026-10', demand_qty: 40 * U, supply_qty: 25 * U, gap_qty: -15 * U, gap_value: -15 * 15_000 * K, constraint: 'material' });
    assert.equal(ex.totals.supply_gap_value, -15 * 15_000 * K);
    // November has demand for the radio but no supply plan at all: said as unknown, never as a shortfall
    assert.equal(ex.demand_without_supply_plan, 1);
  });

  test('the books still balance', async () => {
    assert.equal((await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).balanced, true);
  });
});
