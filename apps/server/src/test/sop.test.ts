import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupCompany, type TestClient } from './helpers.js';

/** S&OP: monthly cycle, demand plan versions (baseline + firm orders + overrides), consensus approval, demand vs supply vs budget. */
describe('S&OP demand plan', () => {
  let c: TestClient;
  const K = 100;
  const U = 1000;
  let customer: number, tv: number, cycle: number;

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Panels' })).id;
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'B.TECH' })).id;
    tv = (await c.post('/api/items', { sku: 'TV55', nameEn: 'TV 55"', nameAr: 'تلفزيون 55', kind: 'product', salePrice: 15_000 * K, purchasePrice: 10_000 * K })).id;
    await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-06-01', post: true, lines: [{ itemId: tv, quantity: 200 * U, unitPrice: 10_000 * K }] });
    // History: 10, 20 and 30 sets invoiced in July–September → a baseline of 20 a month.
    for (const [date, q] of [['2026-07-15', 10], ['2026-08-15', 20], ['2026-09-15', 30]] as const) {
      await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date, post: true, lines: [{ itemId: tv, quantity: q * U, unitPrice: 15_000 * K }] });
    }
    // A firm order due in November.
    await c.post('/api/sales/orders', { customerId: customer, orderDate: '2026-09-20', confirm: true, lines: [{ itemId: tv, quantity: 50 * U, requestedDate: '2026-11-05' }] });
    cycle = (await c.post('/api/sop/cycles', { period: '2026-10' })).id;
  });
  after(() => c.close());

  let v1: number;
  test('a version is built from the baseline and firm orders, valued at the price', async () => {
    const cy = await c.get(`/api/sop/cycles/${cycle}`);
    assert.equal(cy.name, 'S&OP 2026-10');
    assert.equal(cy.months_list.length, 12);
    v1 = (await c.post(`/api/sop/cycles/${cycle}/versions`, { baselineMonths: 3 })).id;
    const v = await c.get(`/api/sop/versions/${v1}`);
    const row = v.rows.find((r: any) => r.item_id === tv);
    const oct = row.cells.find((x: any) => x.month === '2026-10');
    const nov = row.cells.find((x: any) => x.month === '2026-11');
    assert.equal(oct.baseline_qty, 20 * U, 'average of the last three months');
    assert.equal(oct.qty, 20 * U);
    assert.equal(nov.firm_qty, 50 * U);
    assert.equal(nov.qty, 50 * U, 'firm orders above the forecast win');
    assert.equal(nov.amount, 50 * 15_000 * K, 'valued at the price');
    assert.equal(row.cells.length, 12);
  });

  test('overrides change the consensus quantity; approving supersedes the previous plan and freezes it', async () => {
    await c.put(`/api/sop/versions/${v1}/lines`, { lines: [{ itemId: tv, month: '2026-12', qty: 35 * U }] });
    let v = await c.get(`/api/sop/versions/${v1}`);
    const dec = v.rows[0].cells.find((x: any) => x.month === '2026-12');
    assert.equal(dec.override_qty, 35 * U);
    assert.equal(dec.qty, 35 * U);
    await c.post(`/api/sop/versions/${v1}/approve`);
    v = await c.get(`/api/sop/versions/${v1}`);
    assert.equal(v.status, 'approved');
    const frozen = await c.raw('PUT', `/api/sop/versions/${v1}/lines`, { lines: [{ itemId: tv, month: '2026-12', qty: 1 }] });
    assert.equal(frozen.body.error.code, 'sop.not_draft');

    const v2 = (await c.post(`/api/sop/cycles/${cycle}/versions`, { copyFrom: v1 })).id;
    const copy = await c.get(`/api/sop/versions/${v2}`);
    assert.equal(copy.version_no, 2);
    assert.equal(copy.rows[0].cells.find((x: any) => x.month === '2026-12').qty, 35 * U, 'overrides are carried over');
    await c.put(`/api/sop/versions/${v2}/lines`, { lines: [{ itemId: tv, month: '2027-01', qty: 60 * U }] });
    await c.post(`/api/sop/versions/${v2}/approve`);
    assert.equal((await c.get(`/api/sop/versions/${v1}`)).status, 'superseded');
    assert.equal((await c.get(`/api/sop/versions/${v2}`)).status, 'approved');
    const cy = await c.get(`/api/sop/cycles/${cycle}`);
    assert.equal(cy.versions.filter((x: any) => x.status === 'approved').length, 1, 'one approved plan per cycle');
    const plan = await c.get('/api/sop/approved?period=2026-10');
    assert.equal(plan.versionId, v2);
    assert.equal(plan.rows.find((r: any) => r.month === '2027-01').qty, 60 * U);
    const del = await c.raw('DELETE', `/api/sop/versions/${v1}`);
    assert.equal(del.status, 409, 'a decision stays on record');
  });

  test('demand vs supply (with its constraint) and vs the sales budget, in quantity and money', async () => {
    await c.put('/api/sop/supply', { rows: [{ itemId: tv, month: '2026-11', plannedQty: 40 * U, constraint: 'capacity', source: 'gmes' }] });
    const b = (await c.post('/api/budgets', { name: 'Budget 2026', startDate: '2026-01-01' })).id;
    const q = Array(12).fill(0);
    q[10] = 45 * U; // November
    await c.put(`/api/budgets/${b}/sales`, { rows: [{ itemId: tv, quantities: q, unitPrice: 14_000 * K }] });
    const plan = (await c.get('/api/sop/approved?period=2026-10')).versionId;
    const cmp = await c.get(`/api/sop/versions/${plan}/comparison`);
    const nov = cmp.rows[0].cells.find((x: any) => x.month === '2026-11');
    assert.equal(nov.demand_qty, 50 * U);
    assert.equal(nov.supply_qty, 40 * U);
    assert.equal(nov.constraint, 'capacity');
    assert.equal(nov.gap_qty, -10 * U, 'ten sets short');
    assert.equal(nov.gap_value, -10 * 15_000 * K);
    assert.equal(nov.budget_qty, 45 * U);
    assert.equal(nov.budget_value, 45 * 14_000 * K);
    assert.equal(nov.budget_gap_qty, 5 * U);
    assert.equal(nov.budget_gap_value, 50 * 15_000 * K - 45 * 14_000 * K);
    const t = cmp.totals.find((x: any) => x.month === '2026-11');
    assert.equal(t.gap_value, -10 * 15_000 * K);
  });

  test('the books still balance', async () => {
    const tb = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(tb.balanced, true);
    const v = await c.get('/api/inventory/reports/valuation?asOf=2026-12-31');
    assert.equal(v.difference, 0);
  });
});
