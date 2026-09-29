import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../eco-contracts/index.js';
import { setupCompany, type TestClient } from './helpers.js';

/** Sales orders and the approved S&OP plan are published for manufacturing's planning (WP-M3). */
let c: TestClient;
let feedKey: string;
const U = 1000;
before(async () => {
  c = await setupCompany({ vatRateBp: null });
  feedKey = (await c.post('/api/eco/keys', { name: 'reader', scopes: ['eco.feed.read'] })).key;
});
after(() => c.close());

const feed = async () =>
  (await c.app.http.inject({ method: 'GET', url: '/eco/v1/feed?after=0&limit=500', headers: { 'x-eco-key': feedKey } }).then((r) => JSON.parse(r.body))).events as any[];

test('a confirmed sales order and an approved demand plan reach the feed as valid snapshots; drafts do not', async () => {
  const customer = (await c.post('/api/parties', { kind: 'customer', name: 'B.TECH' })).id;
  const tv = (await c.post('/api/items', { sku: 'TV55', nameEn: 'TV 55"', nameAr: 'تلفزيون 55', kind: 'product', salePrice: 1500000 })).id;
  const draft = await c.post('/api/sales/orders', { customerId: customer, orderDate: '2026-09-20', lines: [{ itemId: tv, quantity: 5 * U, requestedDate: '2026-11-05' }] });
  assert.equal((await feed()).filter((e) => e.type === 'acc.sales_order.v1').length, 0, 'a draft is not demand yet');
  await c.post(`/api/sales/orders/${draft.id}/confirm`, {});
  const so = (await feed()).filter((e) => e.type === 'acc.sales_order.v1');
  assert.equal(so.length, 1);
  assert.ok(validateEvent(so[0]).ok);
  assert.deepEqual([so[0].data.status, so[0].data.lines[0].qty, so[0].data.lines[0].item.code], ['open', '5', 'TV55']);

  const cycle = (await c.post('/api/sop/cycles', { period: '2026-10' })).id;
  const v = (await c.post(`/api/sop/cycles/${cycle}/versions`, { baselineMonths: 3 })).id;
  await c.put(`/api/sop/versions/${v}/lines`, { lines: [{ itemId: tv, month: '2026-12', qty: 35 * U }] });
  assert.equal((await feed()).filter((e) => e.type === 'acc.demand_plan.v1').length, 0, 'a draft plan is not published');
  await c.post(`/api/sop/versions/${v}/approve`);
  const dp = (await feed()).filter((e) => e.type === 'acc.demand_plan.v1');
  assert.equal(dp.length, 1);
  assert.ok(validateEvent(dp[0]).ok);
  assert.equal(dp[0].data.status, 'approved');
  assert.equal(dp[0].data.lines.find((l: any) => l.period === '2026-12').qty, '35');
});
