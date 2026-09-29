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

test('a posted goods receipt reaches manufacturing with its purchase order line; a void publishes it voided', async () => {
  const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Chips Co' })).id;
  const chip = (await c.post('/api/items', { sku: 'CHIP-GR', nameEn: 'Chip', nameAr: 'شريحة', kind: 'product', unit: 'PCS', purchasePrice: 5000 })).id;
  const main = (await c.get('/api/inventory/warehouses')).find((w: any) => w.is_default).id;
  const po = (await c.post('/api/purchase-orders', { supplierId: supplier, date: '2026-09-01', approve: true, lines: [{ itemId: chip, quantity: 10 * U, unitPrice: 5000 }] })).id;
  const poLine = (await c.get(`/api/purchase-orders/${po}`)).lines[0].id;
  const gr = (await c.post('/api/inventory/receipts', { supplierId: supplier, poId: po, date: '2026-09-05', warehouseId: main, post: true, lines: [{ itemId: chip, quantity: 10 * U, unitCost: 5000, poLineId: poLine }] })).id;
  const ev = (await feed()).filter((e) => e.type === 'acc.goods_receipt.v1');
  assert.equal(ev.length, 1);
  assert.ok(validateEvent(ev[0]).ok, JSON.stringify(validateEvent(ev[0])));
  assert.deepEqual([ev[0].data.status, ev[0].data.lines[0].qty, ev[0].data.lines[0].po_line_no, ev[0].data.purchase_order.code], ['posted', '10', 1, 'PO-00001']);
  await c.post(`/api/inventory/receipts/${gr}/void`, {});
  const after = (await feed()).filter((e) => e.type === 'acc.goods_receipt.v1');
  assert.equal(after.at(-1).data.status, 'voided');
});

test('a shipment dispatched by manufacturing becomes a posted delivery and a draft invoice, once', async () => {
  const company = (await c.get('/api/eco/company')).companyId as string;
  const inboxKey = (await c.post('/api/eco/keys', { name: 'gmes', scopes: ['eco.inbox.write'] })).key;
  const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Panels' })).id;
  const customer = (await c.post('/api/parties', { kind: 'customer', name: 'Carrefour' })).id;
  const tv = (await c.post('/api/items', { sku: 'TV65', nameEn: 'TV 65"', nameAr: 'تلفزيون 65', kind: 'product', salePrice: 2000000, purchasePrice: 1500000 })).id;
  const wh = (await c.get('/api/inventory/warehouses')).find((w: any) => w.is_default);
  await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-09-01', post: true, lines: [{ itemId: tv, quantity: 20 * U, unitPrice: 1500000 }] });
  const so = await c.post('/api/sales/orders', { customerId: customer, orderDate: '2026-09-20', confirm: true, lines: [{ itemId: tv, quantity: 8 * U, requestedDate: '2026-10-05' }] });
  const order = await c.get(`/api/sales/orders/${so.id}`);
  const { mizanId, newUuidv7 } = await import('../eco-contracts/index.js');
  const eventId = newUuidv7();
  const ship = {
    specversion: '1.0', id: eventId, source: `eco://${company}/gmes/plant-1`, type: 'mes.shipment.dispatched.v1', subject: 'shipment/x', time: '2026-10-04T18:00:00Z',
    datacontenttype: 'application/json', ecoseq: 1, ecocorrelation: 'shipment/x',
    data: {
      shipment: { id: newUuidv7(), code: 'SO-000001', customer: 'Carrefour', customer_party: { id: mizanId(company, 'party', customer), code: 'C' } },
      container: { id: newUuidv7(), number: 'MSCU1234565', seal: 'S1', type: '40HC' },
      lines: [{ sales_order: { id: mizanId(company, 'sales_order', so.id), code: order.number, line_no: 1 }, item: { id: mizanId(company, 'item', tv), code: 'TV65' }, qty: '5', uom: 'PCS', warehouse: { id: mizanId(company, 'warehouse', wh.id), code: wh.code }, pallets: 1 }],
      dispatched_at: '2026-10-04T18:00:00Z', production_date: '2026-10-04', performed_by: { user: 'loader' }, shipping_seq: 1,
    },
  };
  const send = async () => (await c.app.http.inject({ method: 'POST', url: '/eco/v1/inbox', headers: { 'x-eco-key': inboxKey }, payload: { events: [ship] } }).then((r) => JSON.parse(r.body))).results[0];
  const first = await send();
  assert.equal(first.result, 'applied', JSON.stringify(first));
  assert.equal((await send()).result, 'duplicate');
  const after = await c.get(`/api/sales/orders/${so.id}`);
  assert.equal(after.lines[0].delivered_qty, 5 * U);
  assert.equal(after.status, 'partially_delivered');
  const drafts = c.app.kernel.db.all<{ status: string }>("SELECT status FROM documents WHERE kind = 'sales_invoice' AND party_id = ?", [customer]);
  assert.deepEqual(drafts.map((d) => d.status), ['draft']);
  const snaps = (await feed()).filter((e) => e.type === 'acc.sales_order.v1' && e.data.code === order.number);
  assert.equal(snaps.at(-1).data.lines[0].delivered_qty, '5', 'the order goes back to manufacturing with what was delivered');
});
