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

test('a lot put on hold by incoming inspection moves to QA-HOLD, and back when released', async () => {
  const company = (await c.get('/api/eco/company')).companyId as string;
  const inboxKey = (await c.post('/api/eco/keys', { name: 'gmes-qc', scopes: ['eco.inbox.write'] })).key;
  const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Glass Co' })).id;
  const glass = (await c.post('/api/items', { sku: 'GLASS', nameEn: 'Glass', nameAr: 'زجاج', kind: 'product', unit: 'PCS', purchasePrice: 1000 })).id;
  const main = (await c.get('/api/inventory/warehouses')).find((w: any) => w.is_default).id;
  const gr = (await c.post('/api/inventory/receipts', { supplierId: supplier, date: '2026-09-05', warehouseId: main, post: true, lines: [{ itemId: glass, quantity: 50 * U, unitCost: 1000 }] })).id;
  const number = (await c.get(`/api/inventory/receipts/${gr}`)).number;
  const { mizanId, newUuidv7 } = await import('../eco-contracts/index.js');
  const decision = (decision: string) => ({
    specversion: '1.0', id: newUuidv7(), source: `eco://${company}/gmes/plant-1`, type: 'mes.lot_decision.v1', subject: 'lot/x', time: '2026-09-06T08:00:00Z',
    datacontenttype: 'application/json', ecoseq: 1, ecocorrelation: 'lot/x',
    data: { id: newUuidv7(), code: 'LD-1', version: 1, origin: { app: 'gmes', type: 'lot_decision', key: 'LD-1' }, item: { id: mizanId(company, 'item', glass), code: 'GLASS' },
      lot_no: `${number}-1`, goods_receipt: { id: mizanId(company, 'goods_receipt', gr), code: number }, decision, accepted_qty: '0', rejected_qty: '0', uom: 'PCS',
      defect_codes: [], decided_at: '2026-09-06T08:00:00Z', decided_by: { user: 'qc' } },
  });
  const send = async (ev: unknown) => (await c.app.http.inject({ method: 'POST', url: '/eco/v1/inbox', headers: { 'x-eco-key': inboxKey }, payload: { events: [ev] } }).then((r) => JSON.parse(r.body))).results[0];
  const level = (wh: number) => c.app.kernel.db.get<{ qty: number }>('SELECT qty FROM stock_levels WHERE item_id = ? AND warehouse_id = ?', [glass, wh])?.qty ?? 0;
  const held = await send(decision('on_hold'));
  assert.equal(held.result, 'applied', JSON.stringify(held));
  const qa = c.app.kernel.db.get<{ id: number }>("SELECT id FROM warehouses WHERE code = 'QA-HOLD'")!.id;
  assert.deepEqual([level(main), level(qa)], [0, 50 * U]);
  assert.equal((await send(decision('released'))).result, 'applied');
  assert.deepEqual([level(main), level(qa)], [50 * U, 0]);
});

test('production facts from manufacturing are valued through work in progress; the close leaves WIP at zero', async () => {
  const company = (await c.get('/api/eco/company')).companyId as string;
  const inboxKey = (await c.post('/api/eco/keys', { name: 'gmes-prod', scopes: ['eco.inbox.write'] })).key;
  const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Boards Co' })).id;
  const board = (await c.post('/api/items', { sku: 'BOARD', nameEn: 'Board', nameAr: 'لوحة', kind: 'product', unit: 'PCS', purchasePrice: 1000, tracking: 'batch' })).id;
  const set = (await c.post('/api/items', { sku: 'SET-P', nameEn: 'Set', nameAr: 'جهاز', kind: 'product', unit: 'PCS' })).id;
  const main = (await c.get('/api/inventory/warehouses')).find((w: any) => w.is_default);
  await c.post('/api/inventory/receipts', { supplierId: supplier, date: '2026-09-01', warehouseId: main.id, post: true, lines: [{ itemId: board, quantity: 10 * U, unitCost: 1000, lots: [{ lotNo: 'BRD-L1', qty: 10 * U }] }] });
  const { mizanId, newUuidv7 } = await import('../eco-contracts/index.js');
  const ref = (kind: 'item' | 'warehouse', id: number, code: string) => ({ id: mizanId(company, kind, id), code });
  const wo = { id: newUuidv7(), code: 'WO-1', item: ref('item', set, 'SET-P'), planned_qty: '4' };
  const op = { production_date: '2026-09-10', performed_by: { user: 'op' }, ledger_seq: 1 };
  let seq = 0;
  const ev = (type: string, data: unknown) => ({ specversion: '1.0', id: newUuidv7(), source: `eco://${company}/gmes/plant-1`, type, subject: 'wo/1', time: '2026-09-10T10:00:00Z', datacontenttype: 'application/json', ecoseq: ++seq, ecocorrelation: 'wo/1', data });
  const send = async (e: unknown) => (await c.app.http.inject({ method: 'POST', url: '/eco/v1/inbox', headers: { 'x-eco-key': inboxKey }, payload: { events: [e] } }).then((r) => JSON.parse(r.body))).results[0];
  const wh = ref('warehouse', main.id, main.code);
  for (const e of [
    ev('mes.material.consumed.v1', { work_order: wo, item: ref('item', board, 'BOARD'), qty: '4', uom: 'PCS', warehouse: wh, lot_no: 'BRD-L1', ...op }),
    ev('mes.production.completed.v1', { work_order: { ...wo, completed_qty_after: '1', scrapped_qty: '0', is_final: false }, item: ref('item', set, 'SET-P'), qty: '1', uom: 'PCS', warehouse: wh, ...op }),
    ev('mes.production.scrapped.v1', { work_order: wo, qty: '1', uom: 'PCS', reason_code: 'SCRATCH', ...op }),
    ev('mes.production.completed.v1', { work_order: { ...wo, completed_qty_after: '3', scrapped_qty: '1', is_final: true }, item: ref('item', set, 'SET-P'), qty: '2', uom: 'PCS', warehouse: wh, ...op }),
    ev('mes.work_order.closed.v1', { work_order: { ...wo, completed_qty: '3', scrapped_qty: '1' }, ...op }),
  ]) assert.equal((await send(e)).result, 'applied');
  const db = c.app.kernel.db;
  const w = db.get<any>("SELECT * FROM mfg_wip WHERE code = 'WO-1'")!;
  assert.deepEqual([w.issued_value, w.received_value, w.received_qty, w.scrapped_qty, w.status], [4000, 4000, 3 * U, 1 * U, 'closed'], 'the scrapped unit is carried by the good ones');
  const wipAccount = db.get<{ wip_account_id: number }>('SELECT wip_account_id FROM mfg_settings WHERE id = 1')!.wip_account_id;
  const bal = db.get<{ b: number }>('SELECT COALESCE(SUM(debit - credit), 0) b FROM ledger WHERE account_id = ?', [wipAccount])!.b;
  assert.equal(bal, 0, 'work in progress is empty once the order is closed');
  const level = (item: number) => db.get<{ qty: number }>('SELECT qty FROM stock_levels WHERE item_id = ? AND warehouse_id = ?', [item, main.id])?.qty ?? 0;
  assert.deepEqual([level(board), level(set)], [6 * U, 3 * U]);
});

test('a payroll period from HR is booked as one balanced entry per cost centre, refused when unbalanced, reversed on request', async () => {
  const company = (await c.get('/api/eco/company')).companyId as string;
  const inboxKey = (await c.post('/api/eco/keys', { name: 'hr-pay', scopes: ['eco.inbox.write'] })).key;
  const { newUuidv7 } = await import('../eco-contracts/index.js');
  const cc = (await c.post('/api/cost-centers', { code: 'PROD', nameEn: 'Production', nameAr: 'الإنتاج' })).id;
  assert.ok(cc);
  const period = (lines: [string, string, number][], version = 1, status = 'approved', id = '0192f7c4-8a3e-5b21-9c55-3d1f2a4b6c7e') => ({
    specversion: '1.0', id: newUuidv7(), source: `eco://${company}/hr/main`, type: 'hr.payroll_period.v1', subject: 'payroll/x', time: '2026-09-30T08:00:00Z',
    datacontenttype: 'application/json', ecoseq: 1, ecocorrelation: 'payroll/x',
    data: { id, code: 'PAY-2026-09-1', version, origin: { app: 'hr', type: 'payroll_period', key: '2026-09-1' }, period: '2026-09', run: 1, currency: 'EGP', pay_date: '2026-09-30', status,
      lines: lines.map(([cost_center, account_key, amount_minor]) => ({ cost_center, account_key, amount_minor })), headcount: 40, hours: { regular: 6400, overtime_day: 200, overtime_night: 50 } },
  });
  const send = async (e: unknown) => (await c.app.http.inject({ method: 'POST', url: '/eco/v1/inbox', headers: { 'x-eco-key': inboxKey }, payload: { events: [e] } }).then((r) => JSON.parse(r.body))).results[0];
  // earnings 100000 + overtime 10000 = insurance 11000 + tax 9000 + net 90000; employer insurance 18750 is a cost owed to the same authority
  const good: [string, string, number][] = [['PROD', 'gross_earnings', 100000], ['PROD', 'overtime', 10000], ['PROD', 'employer_social_insurance', 18750], ['PROD', 'employee_social_insurance', 11000], ['PROD', 'salary_tax', 9000], ['PROD', 'net_payable', 90000]];
  const bad = await send(period(good.map(([a, b, n]) => [a, b, b === 'net_payable' ? 80000 : n] as [string, string, number])));
  assert.equal(bad.code, 'payroll.unbalanced', JSON.stringify(bad));
  const unknown = await send(period(good.map(([, b, n]) => ['NOPE', b, n] as [string, string, number])));
  assert.equal(unknown.code, 'payroll.unknown_cost_center', JSON.stringify(unknown));
  const ok = await send(period(good));
  assert.equal(ok.result, 'applied', JSON.stringify(ok));
  const db = c.app.kernel.db;
  const entries = db.all<{ id: number; date: string }>("SELECT id, date FROM journal_entries WHERE source_type = 'hr_payroll' ORDER BY id");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.date, '2026-09-30');
  const sums = db.get<{ d: number; c: number }>('SELECT SUM(debit) d, SUM(credit) c FROM journal_lines WHERE entry_id = ?', [entries[0]!.id])!;
  assert.deepEqual([sums.d, sums.c], [128750, 128750]);
  assert.equal((await send(period(good, 1))).result, 'unchanged');
  assert.equal((await c.get('/api/payroll/source')).source, 'hr');
  const blocked = await c.raw('POST', '/api/payroll/runs', { month: '2026-09' });
  assert.equal(blocked.body.error.code, 'payroll.calculated_by_hr');
  assert.equal((await send(period(good, 2, 'reversed'))).result, 'applied');
  const bal = db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) b FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_type = 'hr_payroll')", [])!.b;
  assert.equal(bal, 0, 'the reversal cancels the booking');
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
