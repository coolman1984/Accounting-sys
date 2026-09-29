import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

/** Sales & distribution: order → reservation / ATP → delivery (goods issue) → invoice from the delivery. */
describe('sales orders, deliveries and billing (SAP SD, simplified)', () => {
  let c: TestClient;
  const K = 100; // piasters per pound
  const U = 1000; // one unit
  let vat: number, supplier: number, alpha: number, beta: number, gamma: number;
  let tv: number, tv2: number, tv3: number, main: number, cogs: number, revenue: number;

  const buy = (item: number, qty: number, cost: number, date = '2026-03-01') =>
    c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date, post: true, lines: [{ itemId: item, quantity: qty * U, unitPrice: cost * K }] });
  const onHand = async (item: number) => (await c.get(`/api/inventory/levels?warehouseId=${main}`))[item] ?? 0;
  const movement = async (accountId: number) => {
    const tb = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    const r = tb.rows.find((x: any) => x.id === accountId || x.account_id === accountId);
    return r ? (r.closing_debit ?? r.debit ?? 0) - (r.closing_credit ?? r.credit ?? 0) : 0;
  };
  const order = (customerId: number, lines: any[], extra: Record<string, unknown> = {}) =>
    c.post('/api/sales/orders', { customerId, orderDate: '2026-04-01', lines, ...extra }).then((r) => r.id as number);
  const get = (id: number) => c.get(`/api/sales/orders/${id}`);
  const reconciled = async () => {
    const v = await c.get('/api/inventory/reports/valuation?asOf=2026-12-31');
    assert.equal(v.difference, 0, `stock valuation ${v.total} equals the inventory account ${v.ledger}`);
    const tb = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(tb.balanced, true, 'trial balance balances');
  };

  before(async () => {
    c = await setupCompany();
    vat = (await c.get('/api/taxes'))[0].id;
    cogs = await acc(c, '5100');
    revenue = await acc(c, '4100');
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Panel Maker' })).id;
    alpha = (await c.post('/api/parties', { kind: 'customer', name: 'Alpha Retail', paymentTermsDays: 45 })).id;
    beta = (await c.post('/api/parties', { kind: 'customer', name: 'Beta Stores', creditLimit: 100_000 * K })).id;
    gamma = (await c.post('/api/parties', { kind: 'customer', name: 'Gamma Online' })).id;
    tv = (await c.post('/api/items', { sku: 'TV55', nameEn: 'TV 55"', nameAr: 'تلفزيون 55', kind: 'product', salePrice: 15_000 * K, purchasePrice: 10_000 * K, salesTaxId: vat })).id;
    tv2 = (await c.post('/api/items', { sku: 'TV65', nameEn: 'TV 65"', nameAr: 'تلفزيون 65', kind: 'product', salePrice: 25_000 * K, purchasePrice: 18_000 * K })).id;
    tv3 = (await c.post('/api/items', { sku: 'TV43', nameEn: 'TV 43"', nameAr: 'تلفزيون 43', kind: 'product', salePrice: 9_000 * K, purchasePrice: 6_000 * K })).id;
    main = (await c.get('/api/inventory/warehouses')).find((w: any) => w.code === 'MAIN').id;
    await buy(tv, 10, 10_000);
    await buy(tv3, 100, 6_000);
  });
  after(() => c.close());

  let so1: number;
  test('order life cycle: draft → confirmed (reserved, promised) → partially delivered → closed', async () => {
    so1 = await order(alpha, [{ itemId: tv, quantity: 5 * U, requestedDate: '2026-04-10' }], { customerReference: 'PO-ALPHA-7' });
    let o = await get(so1);
    assert.equal(o.status, 'draft');
    assert.equal(o.number, null);
    assert.equal(o.lines[0].unit_price, 15_000 * K, 'price from the item when the customer has no price list');
    assert.equal(o.lines[0].tax_id, vat, "the item's sales tax");
    assert.equal(o.payment_terms_days, 45, 'payment terms from the customer');
    assert.equal(o.total, 5 * 15_000 * K * 1.14);

    await c.post(`/api/sales/orders/${so1}/confirm`);
    o = await get(so1);
    assert.equal(o.status, 'confirmed');
    assert.equal(o.number, 'SO-00001');
    assert.equal(o.lines[0].reserved_qty, 5 * U, 'confirming reserves the stock');
    assert.equal(o.lines[0].promised_date, '2026-04-10', 'in stock: promised on the requested date');

    const d1 = (await c.post('/api/sales/deliveries', { soId: so1, date: '2026-04-08', lines: [{ soLineId: o.lines[0].id, qty: 2 * U }], post: true })).id;
    o = await get(so1);
    assert.equal(o.status, 'partially_delivered');
    assert.equal(o.lines[0].delivered_qty, 2 * U);
    assert.equal(o.lines[0].reserved_qty, 3 * U, 'the delivered part leaves the reservation');
    assert.equal(await onHand(tv), 8 * U, 'goods issue took 2 out of stock');
    const d = await c.get(`/api/sales/deliveries/${d1}`);
    assert.equal(d.status, 'posted');
    assert.equal(d.number, 'DLV-00001');
    assert.equal(d.lines[0].cost, 2 * 10_000 * K, 'at moving-average cost');
    assert.equal(await movement(cogs), 2 * 10_000 * K, 'cost of sales booked by the delivery');

    // The rest (prepared from the order: everything still open).
    const d2 = (await c.post('/api/sales/deliveries', { soId: so1, date: '2026-04-10' })).id;
    await c.post(`/api/sales/deliveries/${d2}/post`);
    o = await get(so1);
    assert.equal(o.status, 'closed');
    assert.equal(o.lines[0].reserved_qty, 0);
    assert.equal(await onHand(tv), 5 * U);
    await reconciled();
  });

  test('an invoice made from the deliveries bills them without issuing the stock again', async () => {
    const dels = (await c.get(`/api/sales/deliveries?soId=${so1}`)).rows.map((x: any) => x.id);
    const before = { stock: await onHand(tv), cogs: await movement(cogs) };
    const { id } = await c.post('/api/sales/invoices/from-deliveries', { deliveryIds: dels, date: '2026-04-12', post: true });
    const inv = await c.get(`/api/documents/${id}`);
    assert.equal(inv.status, 'posted');
    assert.equal(inv.lines.length, 2, 'one line per delivery line');
    assert.equal(inv.subtotal, 5 * 15_000 * K);
    assert.equal(inv.due_date, '2026-05-27', 'due after the 45 days of the order');
    assert.equal(await onHand(tv), before.stock, 'no second goods issue');
    assert.equal(await movement(cogs), before.cogs, 'no second cost of sales');
    assert.equal(await movement(revenue), -5 * 15_000 * K, 'revenue is booked by the invoice');
    const o = await get(so1);
    assert.equal(o.lines[0].invoiced_qty, 5 * U);
    assert.equal(o.invoices.length, 1);

    const again = await c.raw('POST', '/api/sales/invoices/from-deliveries', { deliveryIds: dels });
    assert.equal(again.body.error.code, 'sales.nothing_to_invoice');
    // A hand-made invoice line pointing at a delivery cannot bill it twice either.
    const dl = (await c.get(`/api/sales/deliveries/${dels[0]}`)).lines[0];
    const twice = await c.raw('POST', '/api/documents', {
      kind: 'sales_invoice', partyId: alpha, date: '2026-04-13', post: true,
      lines: [{ itemId: tv, quantity: 1 * U, unitPrice: 15_000 * K, ext: { deliveryLineId: dl.id } }],
    });
    assert.equal(twice.body.error.code, 'sales.over_invoiced');
    const posted = await c.raw('POST', `/api/sales/deliveries/${dels[0]}/void`, {});
    assert.equal(posted.body.error.code, 'sales.delivery_invoiced', 'an invoiced delivery cannot be voided');
    await reconciled();

    // A return against that invoice comes back at the cost the goods left at.
    await c.post('/api/documents', { kind: 'sales_credit', partyId: alpha, date: '2026-04-20', againstDocumentId: id, post: true, lines: [{ itemId: tv, quantity: 1 * U, unitPrice: 15_000 * K }] });
    assert.equal(await onHand(tv), before.stock + 1 * U);
    assert.equal(await movement(cogs), before.cogs - 10_000 * K);
    await reconciled();
  });

  test('credit limit: confirming is blocked unless someone with the override right says so', async () => {
    const id = await order(beta, [{ itemId: tv3, quantity: 12 * U, unitPrice: 9_000 * K }]);
    const r = await c.raw('POST', `/api/sales/orders/${id}/confirm`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'sales.credit_limit');
    assert.equal(r.body.error.details.exposure, 12 * 9_000 * K, 'no tax on this item');
    assert.equal((await get(id)).status, 'draft');
    // A clerk without the override right cannot force it.
    const role = (await c.post('/api/roles', { name: 'Order clerk', permissions: ['sales.orders.read', 'sales.orders.write', 'sales.orders.approve'] })).id;
    await c.post('/api/users', { username: 'clerk', displayName: 'Clerk', password: 'password123', roleIds: [role] });
    const clerk = await c.login('clerk', 'password123');
    const forced = await c.raw('POST', `/api/sales/orders/${id}/confirm`, { override: true }, clerk);
    assert.equal(forced.body.error.code, 'sales.credit_limit');
    await c.post(`/api/sales/orders/${id}/confirm`, { override: true });
    const o = await get(id);
    assert.equal(o.status, 'confirmed');
    assert.ok(o.credit_override_by, 'who overrode is recorded');
    await c.post(`/api/sales/orders/${id}/close`);
  });

  test('reservations never exceed the stock, and reserved stock is not sold by a direct invoice', async () => {
    const stock = await onHand(tv); // 6
    const big = await order(alpha, [{ itemId: tv, quantity: 10 * U, requestedDate: '2026-04-15' }], { confirm: true });
    const o = await get(big);
    assert.equal(o.lines[0].reserved_qty, stock, 'only what is on hand is reserved');
    assert.equal(o.lines[0].promised_date, null, 'the rest has no known supply yet');
    const second = await order(gamma, [{ itemId: tv, quantity: 2 * U }], { confirm: true });
    assert.equal((await get(second)).lines[0].reserved_qty, 0, 'nothing left to reserve');
    const res = await c.get(`/api/sales/reservations?itemId=${tv}`);
    assert.equal(res[0].qty, stock);
    assert.ok(res.every((x: any) => x.qty <= x.onHand && x.free >= 0));
    const direct = await c.raw('POST', '/api/documents', { kind: 'sales_invoice', partyId: gamma, date: '2026-04-16', post: true, lines: [{ itemId: tv, quantity: 1 * U, unitPrice: 15_000 * K }] });
    assert.equal(direct.body.error.code, 'stock.reserved');
    // Delivering the unreserved order is refused too: its goods are someone else's.
    const d = await c.raw('POST', '/api/sales/deliveries', { soId: second, date: '2026-04-16', post: true });
    assert.equal(d.body.error.code, 'sales.not_available');
    // New stock arrives: rescheduling reserves it by the order's needs.
    await buy(tv, 10, 11_000, '2026-04-17');
    await c.post(`/api/sales/orders/${big}/reschedule`);
    assert.equal((await get(big)).lines[0].reserved_qty, 10 * U);
    await c.post(`/api/sales/orders/${second}/reschedule`);
    assert.equal((await get(second)).lines[0].reserved_qty, 2 * U);
    await c.post(`/api/sales/orders/${big}/close`);
    await c.post(`/api/sales/orders/${second}/close`);
    assert.deepEqual(await c.get(`/api/sales/reservations?itemId=${tv}`), [], 'closing releases the reservations');
    await reconciled();
  });

  test('ATP: the first date the full quantity is available counts open purchase orders and planned production', async () => {
    await buy(tv2, 10, 18_000);
    await c.post('/api/purchase-orders', { supplierId: supplier, date: '2026-04-01', expectedDate: '2026-06-15', approve: true, lines: [{ itemId: tv2, quantity: 50 * U, unitPrice: 18_000 * K }] });
    let a = await c.get(`/api/sales/atp?itemId=${tv2}&qty=${30 * U}&date=2026-05-01&asOf=2026-04-01`);
    assert.equal(a.free, 10 * U);
    assert.equal(a.availableNow, false);
    assert.equal(a.availableDate, '2026-06-15', 'when the purchase order arrives');
    a = await c.get(`/api/sales/atp?itemId=${tv2}&qty=${8 * U}&date=2026-05-01&asOf=2026-04-01`);
    assert.equal(a.availableDate, '2026-05-01', 'in stock: on the requested date');

    // Planned production (filled later from the manufacturing system) brings it forward.
    await c.put('/api/sales/supply-plan', { rows: [{ itemId: tv2, date: '2026-06-01', qty: 25 * U, source: 'gmes', reference: 'MPS W22' }] });
    a = await c.get(`/api/sales/atp?itemId=${tv2}&qty=${30 * U}&date=2026-05-01&asOf=2026-04-01`);
    assert.equal(a.availableDate, '2026-06-01');

    // Confirming promises that date; a later order waits for the next supply.
    const first = await order(gamma, [{ itemId: tv2, quantity: 30 * U, requestedDate: '2026-05-01' }], { confirm: true });
    const l = (await get(first)).lines[0];
    assert.equal(l.reserved_qty, 10 * U);
    assert.equal(l.promised_date, '2026-06-01');
    a = await c.get(`/api/sales/atp?itemId=${tv2}&qty=${10 * U}&date=2026-05-01&asOf=2026-04-01`);
    assert.equal(a.availableDate, '2026-06-15', 'the planned production is already promised to the first order');
    await c.post(`/api/sales/orders/${first}/close`);
  });

  test('OTD and OTIF per customer on crafted on-time, late and partial deliveries', async () => {
    const delta = (await c.post('/api/parties', { kind: 'customer', name: 'Delta Hyper' })).id;
    const id = await order(delta, [
      { itemId: tv3, quantity: 4 * U, requestedDate: '2026-04-10' }, // on time, in full
      { itemId: tv3, quantity: 4 * U, requestedDate: '2026-04-10' }, // late
      { itemId: tv3, quantity: 10 * U, requestedDate: '2026-04-10' }, // first part on time, the rest late
      { itemId: tv3, quantity: 2 * U, requestedDate: '2026-04-05' }, // promised later than requested, delivered on the promise
    ], { confirm: true });
    const ls = (await get(id)).lines;
    await c.put(`/api/sales/orders/${id}/lines/${ls[3].id}/promise`, { date: '2026-04-12' });
    const deliver = (lineId: number, qty: number, date: string) => c.post('/api/sales/deliveries', { soId: id, date, post: true, lines: [{ soLineId: lineId, qty: qty * U }] });
    await deliver(ls[0].id, 4, '2026-04-09');
    await deliver(ls[1].id, 4, '2026-04-15');
    await deliver(ls[2].id, 6, '2026-04-10');
    await deliver(ls[2].id, 4, '2026-04-20');
    await deliver(ls[3].id, 2, '2026-04-11');
    const r = await c.get('/api/sales/reports/otif?from=2026-04-01&to=2026-04-30&groupBy=customer');
    const g = r.rows.find((x: any) => x.key === delta);
    assert.equal(g.lines, 4);
    assert.equal(g.otd_promised, 3, 'lines 1, 3 and 4 started on time');
    assert.equal(g.otif_promised, 2, 'lines 1 and 4 were complete by their date');
    assert.equal(g.otd_requested, 2, 'line 4 was late against the requested date');
    assert.equal(g.otif_requested, 1);
    assert.equal(g.otif_promised_bp, 5000);
    assert.equal(g.fill_rate_bp, 10000, 'everything was delivered in the end');
    const late = r.details.find((x: any) => x.line_id === ls[1].id);
    assert.equal(late.days_late, 5);

    const sales = await c.get('/api/sales/reports/sales?from=2026-04-01&to=2026-04-30&groupBy=customer');
    const alphaRow = sales.rows.find((x: any) => x.key === alpha);
    assert.equal(alphaRow.revenue, 4 * 15_000 * K, 'five sold, one returned');
    assert.equal(alphaRow.cost, 4 * 10_000 * K);
    assert.equal(alphaRow.margin, 4 * 5_000 * K);
    const backlog = await c.get('/api/sales/reports/backlog?groupBy=customer');
    assert.ok(Array.isArray(backlog.rows));
    const aging = await c.get('/api/sales/reports/aging');
    assert.ok(aging.buckets.length === 4);
  });

  test('the integration entry point delivers a line once per reference', async () => {
    const id = await order(gamma, [{ itemId: tv3, quantity: 5 * U }], { confirm: true });
    const lineId = (await get(id)).lines[0].id;
    const stock = await onHand(tv3);
    const a = await c.post('/api/sales/deliveries/deliver-line', { soLineId: lineId, qty: 3 * U, date: '2026-04-22', reference: 'eco:evt-1001' });
    const b = await c.post('/api/sales/deliveries/deliver-line', { soLineId: lineId, qty: 3 * U, date: '2026-04-22', reference: 'eco:evt-1001' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.deliveryId, a.deliveryId);
    assert.equal(await onHand(tv3), stock - 3 * U, 'stock left once');
    // Voiding a delivery that is not invoiced puts the goods back and reopens the order.
    await c.post(`/api/sales/deliveries/${a.deliveryId}/void`, {});
    assert.equal(await onHand(tv3), stock);
    const o = await get(id);
    assert.equal(o.status, 'confirmed');
    assert.equal(o.lines[0].reserved_qty, 5 * U);
    await reconciled();
  });

  test('every health check passes', async () => {
    const health = await c.get('/api/system/health');
    const bad = health.flatMap((m: any) => m.checks.filter((x: any) => !x.ok).map((x: any) => `${m.module}.${x.id}`));
    assert.deepEqual(bad.filter((x: string) => x !== 'system.backup'), []);
  });
});
