import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

const healthOk = async (c: TestClient) => {
  const h = await c.get('/api/system/health');
  const bad = h.flatMap((m: any) => [...(m.error ? [`${m.module}: ${m.error}`] : []), ...m.checks.filter((x: any) => !x.ok && x.severity !== 'warning').map((x: any) => `${m.module}.${x.id}`)]);
  assert.deepEqual(bad, [], 'every module reports healthy');
  return h;
};

describe('apps — sell only what the customer needs', () => {
  test('accounting only: the ledger works, everything else is locked away', async () => {
    const c = await setupCompany({ apps: [] });
    try {
      const me = await c.get('/api/auth/me');
      assert.deepEqual(me.apps, ['accounting']);
      assert.ok(me.user.permissions.includes('journal.post'));
      assert.ok(!me.user.permissions.some((p: string) => /^(sales|purchases|payments|inventory|purchasing|pricing|parties|catalog)\./.test(p)));
      assert.equal((await c.raw('GET', '/api/documents?kind=sales_invoice')).status, 403);
      assert.equal((await c.raw('GET', '/api/inventory/stock')).status, 403);
      const cash = await acc(c, '1110');
      const capital = await acc(c, '3100');
      await c.post('/api/journal', {
        date: '2026-01-02', memo: 'Capital', post: true,
        lines: [{ accountId: cash, debit: 100000 }, { accountId: capital, credit: 100000 }],
      });
      assert.equal((await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).balanced, true);
      await healthOk(c);
    } finally {
      await c.close();
    }
  });

  let c: TestClient;
  before(async () => {
    c = await setupCompany({ apps: ['sales', 'purchases'], vatRateBp: null });
  });
  after(() => c.close());

  test('without the Inventory app, products are bought as expenses and sold without stock checks', async () => {
    const me = await c.get('/api/auth/me');
    assert.deepEqual(me.apps.sort(), ['accounting', 'purchases', 'sales']);
    const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'S' })).id;
    const customer = (await c.post('/api/parties', { kind: 'customer', name: 'C' })).id;
    const item = (await c.post('/api/items', { sku: 'P1', nameEn: 'Product', nameAr: 'منتج', kind: 'product', salePrice: 1500, purchasePrice: 1000 })).id;
    const bill = (await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-02-01', post: true, lines: [{ itemId: item, quantity: 5000, unitPrice: 1000 }] })).id;
    const b = await c.get(`/api/documents/${bill}`);
    assert.equal(b.lines[0].account_id, await acc(c, '5150'), 'purchases expense, not the inventory asset');
    // Selling more than was bought is fine: no perpetual stock without the app.
    const inv = (await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-02-02', post: true, lines: [{ itemId: item, quantity: 8000, unitPrice: 1500 }] })).id;
    const d = await c.get(`/api/documents/${inv}`);
    assert.equal(d.status, 'posted');
    const moves = c.app.kernel.db.get<{ n: number }>('SELECT COUNT(*) n FROM stock_moves')!.n;
    assert.equal(moves, 0);
    await healthOk(c);
  });

  test('apps check their requirements; switching on keeps working at once', async () => {
    const bad = await c.raw('PUT', '/api/system/apps', { enabled: ['purchasing'] });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, 'apps.requires');
    const list = await c.put('/api/system/apps', { enabled: ['sales', 'purchases', 'inventory', 'purchasing'] });
    assert.ok(list.find((a: any) => a.id === 'inventory').enabled);
    const me = await c.get('/api/auth/me');
    assert.ok(me.user.permissions.includes('inventory.write'), 'no restart or new login needed');
    assert.equal((await c.raw('GET', '/api/inventory/stock')).status, 200);
    // Now stock items go to the inventory asset.
    const supplier = (await c.get('/api/parties?kind=supplier')).rows[0].id;
    const item = (await c.post('/api/items', { sku: 'P2', nameEn: 'Stocked', nameAr: 'مخزني', kind: 'product', purchasePrice: 700 })).id;
    const bill = (await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-03-01', post: true, lines: [{ itemId: item, quantity: 2000, unitPrice: 700 }] })).id;
    assert.equal((await c.get(`/api/documents/${bill}`)).lines[0].account_id, await acc(c, '1140'));
    await healthOk(c);
    // Turning an app off hides it for everyone right away.
    await c.put('/api/system/apps', { enabled: ['sales', 'purchases'] });
    assert.equal((await c.raw('GET', '/api/purchase-orders')).status, 403);
  });

  test('health checks run per module, so a fault points at its module', async () => {
    await c.put('/api/system/apps', { enabled: ['sales', 'purchases', 'inventory'] });
    await healthOk(c);
    // Break the stock pool on purpose (outside the app, as a crash or manual edit would).
    c.app.kernel.db.run('UPDATE stock_values SET value = value + 1');
    const h = await c.get('/api/system/health');
    const failing = h.flatMap((m: any) => m.checks.filter((x: any) => !x.ok && x.severity !== 'warning').map((x: any) => `${m.module}.${x.id}`));
    assert.deepEqual(failing.sort(), ['inventory.levels', 'inventory.valuation']);
    c.app.kernel.db.run('UPDATE stock_values SET value = value - 1');
    await healthOk(c);
  });
});
