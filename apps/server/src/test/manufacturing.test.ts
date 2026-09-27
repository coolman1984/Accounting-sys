import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';
import { monthFraction, standardCost } from '../modules/manufacturing/engine.js';

/**
 * A chair: batch of 10 uses 20 wood (standard 48) and 80 screws + 5 % scrap (standard 1), 5 labour hours
 * at 40, variable overhead 10/h, fixed overhead 30/h → standard 1,444 a batch, 144.40 a chair.
 * Order for 20 chairs; actual: wood 42 (bought at 50), screws 170, 11 hours costing 473.
 *   standard for 20 = 2,888; actual = 2,100 + 170 + 473 + 440 applied = 3,183; variance −295:
 *   material price −84, usage −98, labour rate −33, efficiency −40, variable overhead efficiency −10,
 *   fixed overhead on actual hours −30.
 */
describe('manufacturing: recipes, production orders and cost variances', () => {
  let c: TestClient;
  const K = 100;
  let wood: number, screws: number, chair: number, main: number, bom: number, order: number, inv: number, utilities: number;
  const tb = async () => {
    const t = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(t.balanced, true);
    return t;
  };
  const balance = async (accountId: number) => {
    const t = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    const row = t.rows.find((r: any) => r.account_id === accountId || r.id === accountId);
    return row ? (row.closing_debit ?? row.debit ?? 0) - (row.closing_credit ?? row.credit ?? 0) : 0;
  };

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    inv = await acc(c, '1140');
    utilities = await acc(c, '5230');
    const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Timber Co' })).id;
    const item = (sku: string, name: string, price: number) => c.post('/api/items', { sku, nameEn: name, nameAr: name, kind: 'product', salePrice: price * K, purchasePrice: price * K }).then((r) => r.id as number);
    wood = await item('WOOD', 'Wood plank', 50);
    screws = await item('SCR', 'Screw', 1);
    chair = await item('CHAIR', 'Chair', 400);
    main = (await c.get('/api/inventory/warehouses')).find((w: any) => w.code === 'MAIN').id;
    await c.post('/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-03-01', post: true,
      lines: [{ itemId: wood, quantity: 100_000, unitPrice: 50 * K }, { itemId: screws, quantity: 1_000_000, unitPrice: 1 * K }],
    });
  });
  after(() => c.close());

  test('engine: standard cost roll-up and month fractions', () => {
    const s = standardCost({ outputQty: 10_000, labourHours: 5_000, labourRate: 40, varOverheadRate: 10, fixedOverheadRate: 30, components: [{ itemId: 1, qty: 20_000, scrapBp: 0, stdCost: 48 }, { itemId: 2, qty: 80_000, scrapBp: 500, stdCost: 1 }] });
    assert.deepEqual(s.batch, { materials: 1044, labour: 200, varOverhead: 50, fixedOverhead: 150, total: 1444 });
    assert.equal(monthFraction('2026-03-01', '2026-03-31'), 1);
    assert.equal(monthFraction('2026-01-01', '2026-06-30'), 6);
    assert.ok(Math.abs(monthFraction('2026-02-15', '2026-02-28') - 14 / 28) < 1e-9);
  });

  test('a recipe rolls up its standard cost; bad recipes are refused', async () => {
    const bad = await c.raw('POST', '/api/mfg/boms', { itemId: chair, name: 'x', outputQty: 1000, lines: [{ itemId: chair, qty: 1000 }] });
    assert.equal(bad.body.error.code, 'mfg.self_component');
    const dup = await c.raw('POST', '/api/mfg/boms', { itemId: chair, name: 'x', outputQty: 1000, lines: [{ itemId: wood, qty: 1000 }, { itemId: wood, qty: 1000 }] });
    assert.equal(dup.body.error.code, 'mfg.duplicate_component');
    bom = (
      await c.post('/api/mfg/boms', {
        itemId: chair, name: 'Chair standard', outputQty: 10_000, labourHours: 5_000, labourRate: 40 * K, varOverheadRate: 10 * K, fixedOverheadRate: 30 * K,
        lines: [{ itemId: wood, qty: 20_000, stdCost: 48 * K }, { itemId: screws, qty: 80_000, scrapBp: 500 }],
      })
    ).id;
    const b = await c.get(`/api/mfg/boms/${bom}`);
    assert.equal(b.lines[1].std_cost, 1 * K, 'standard defaults to the current average cost');
    assert.equal(b.standard.batch.total, 1444 * K);
    assert.equal(b.standard.unit.total, 144.4 * K);
    assert.equal(b.current.batch.materials, (20 * 50 + 84) * K, 'at today’s costs');
  });

  test('completing an order moves stock, books one entry and explains every variance', async () => {
    order = (await c.post('/api/mfg/orders', { bomId: bom, plannedQty: 20_000, date: '2026-03-10', warehouseId: main })).id;
    const draft = await c.get(`/api/mfg/orders/${order}`);
    assert.deepEqual(draft.lines.map((l: any) => l.qty), [40_000, 168_000], 'materials allowed for 20 chairs');
    assert.equal(draft.labour_hours, 10_000);
    await c.put(`/api/mfg/orders/${order}`, {
      date: '2026-03-10', warehouseId: main, outputWarehouseId: main, outputQty: 20_000, labourHours: 11_000, labourCost: 473 * K,
      lines: [{ itemId: wood, qty: 42_000 }, { itemId: screws, qty: 170_000 }],
    });
    const done = await c.post(`/api/mfg/orders/${order}/complete`);
    assert.equal(done.status, 'done');
    assert.equal(done.materials_cost, 2270 * K);
    assert.equal(done.overhead_applied, 440 * K);
    assert.equal(done.total_cost, 3183 * K);
    const v = done.variances.totals;
    assert.equal(v.standard, 2888 * K);
    assert.equal(v.materialPrice, -84 * K);
    assert.equal(v.materialUsage, -98 * K);
    assert.equal(v.labourRate, -33 * K);
    assert.equal(v.labourEfficiency, -40 * K);
    assert.equal(v.varOverheadEfficiency, -10 * K);
    assert.equal(v.fixedOverheadEfficiency, -30 * K);
    assert.equal(v.total, -295 * K);
    assert.equal(v.materialPrice + v.materialUsage + v.labourRate + v.labourEfficiency + v.varOverheadEfficiency + v.fixedOverheadEfficiency, v.total);
    const card = await c.get(`/api/inventory/items/${chair}`);
    assert.equal(card.value, 3183 * K);
    assert.equal((await c.get(`/api/inventory/items/${wood}`)).value, 58 * 50 * K);
    await tb();
    assert.equal(await balance(inv), (5000 + 1000 - 2270 + 3183) * K, 'inventory = purchases − materials + product');
    const again = await c.raw('POST', `/api/mfg/orders/${order}/complete`);
    assert.equal(again.body.error.code, 'mfg.not_draft');
  });

  test('period report: order variances and overhead applied vs actual', async () => {
    const je = await c.post('/api/journal', { date: '2026-03-31', post: true, lines: [{ accountId: utilities, debit: 500 * K, credit: 0 }, { accountId: await acc(c, '1120'), debit: 0, credit: 500 * K }] });
    assert.ok(je.id);
    await c.put('/api/mfg/settings', { budgetFixedOverhead: 300 * K, overheadAccounts: [utilities] });
    const r = await c.get('/api/mfg/variances?from=2026-03-01&to=2026-03-31');
    assert.equal(r.orders.length, 1);
    assert.equal(r.totals.total, -295 * K);
    assert.equal(r.overhead.appliedVariable + r.overhead.appliedFixed, 440 * K);
    assert.equal(r.overhead.budgetedFixed, 300 * K);
    assert.equal(r.overhead.absorbed, -60 * K, 'applied 440 − actual 500: under-absorbed');
    assert.equal(r.overhead.fixedSpending, -200 * K);
    assert.equal(r.overhead.fixedVolume, 0, 'standard fixed 300 = budget 300');
  });

  test('not enough stock blocks completion; a completed order can be reversed', async () => {
    const big = (await c.post('/api/mfg/orders', { bomId: bom, plannedQty: 1_000_000, date: '2026-03-12', warehouseId: main })).id;
    const fail = await c.raw('POST', `/api/mfg/orders/${big}/complete`);
    assert.equal(fail.body.error.code, 'stock.insufficient');
    await c.del(`/api/mfg/orders/${big}`);
    await c.post(`/api/mfg/orders/${order}/void`, {});
    assert.equal((await c.get(`/api/inventory/items/${chair}`)).value, 0);
    assert.equal((await c.get(`/api/inventory/items/${wood}`)).value, 100 * 50 * K);
    await tb();
    assert.equal(await balance(inv), 6000 * K, 'back to purchases');
    const s = await c.get('/api/mfg/settings');
    assert.equal(await balance(s.labour_account_id), 0);
    assert.equal(await balance(s.overhead_account_id), 0);
    const del = await c.raw('DELETE', `/api/mfg/orders/${order}`);
    assert.equal(del.body.error.code, 'mfg.not_draft');
  });
});
