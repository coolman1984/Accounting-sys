import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

describe('inventory — units, lots, serials, receipts, landed costs, recosting, pricing', () => {
  let c: TestClient;
  let supplier: number;
  let customer: number;
  let main: number;
  let ids: Record<string, number>;

  const reconciled = async () => {
    const v = await c.get('/api/inventory/reports/valuation?asOf=2026-12-31');
    assert.equal(v.difference, 0, `ledger ${v.ledger} vs stock ${v.total}`);
    const bad = c.app.kernel.db.all(
      `SELECT v.item_id FROM stock_values v
       WHERE v.qty <> (SELECT COALESCE(SUM(qty), 0) FROM stock_levels l WHERE l.item_id = v.item_id)
          OR v.value <> (SELECT COALESCE(SUM(value), 0) FROM stock_moves m WHERE m.item_id = v.item_id)`,
    );
    assert.deepEqual(bad, []);
    const lotBad = c.app.kernel.db.all(
      `SELECT l.item_id, l.warehouse_id FROM stock_levels l JOIN items i ON i.id = l.item_id
       WHERE i.tracking <> 'none' AND l.qty <> (SELECT COALESCE(SUM(ll.qty), 0) FROM lot_levels ll JOIN stock_lots s ON s.id = ll.lot_id
                                                WHERE s.item_id = l.item_id AND ll.warehouse_id = l.warehouse_id)`,
    );
    assert.deepEqual(lotBad, [], 'lot levels add up to warehouse levels');
    assert.equal((await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).balanced, true);
  };
  const card = (id: number) => c.get(`/api/inventory/items/${id}`);
  const level = async (item: number) => (await c.get(`/api/inventory/levels?warehouseId=${main}`))[item] ?? 0;
  const item = (body: object) => c.post('/api/items', { kind: 'product', ...body }).then((r) => r.id as number);
  const bill = (lines: object[], extra: object = {}) =>
    c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-02-01', post: true, lines, ...extra }).then((r) => r.id as number);
  const invoice = (lines: object[], extra: object = {}) =>
    c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-03-01', post: true, lines, ...extra }).then((r) => r.id as number);

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Pharma Supply' })).id;
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'City Pharmacy' })).id;
    main = (await c.get('/api/inventory/warehouses'))[0].id;
    ids = {};
    for (const code of ['1140', '2160', '5100']) ids[code] = await acc(c, code);
  });
  after(() => c.close());

  // ------------------------------------------------------------ units
  let water: number;
  let box: number;
  test('units of measure: buy in boxes, sell in pieces or boxes', async () => {
    water = await item({ sku: 'WTR', nameEn: 'Water bottle', nameAr: 'زجاجة مياه', unit: 'pcs', salePrice: 1500,
      units: [{ nameEn: 'Box', nameAr: 'كرتونة', factor: 12000, barcode: 'BOX-WTR', salePrice: 16000 }] });
    const units = (await card(water)).units;
    box = units[0].id;
    await bill([{ itemId: water, unitId: box, quantity: 2000, unitPrice: 12000 }]); // 2 boxes @ 120.00
    assert.equal(await level(water), 24000);
    assert.equal((await card(water)).value, 24000);
    await invoice([
      { itemId: water, quantity: 5000, unitPrice: 1500 },
      { itemId: water, unitId: box, quantity: 1000, unitPrice: 16000 },
    ]);
    assert.equal(await level(water), 7000);
    const lookup = await c.get('/api/items/lookup?barcode=BOX-WTR');
    assert.equal(lookup.unit.id, box);
    await reconciled();
  });

  test('profitability counts base units', async () => {
    const p = await c.get('/api/inventory/reports/profitability?from=2026-01-01&to=2026-12-31');
    const row = p.rows.find((r: any) => r.id === water);
    assert.equal(row.qty, 17000);
    assert.equal(row.cost, 17000);
  });

  // ------------------------------------------------------------- lots
  let medicine: number;
  test('batches with expiry: expiry is required, lots are created on receipt', async () => {
    medicine = await item({ sku: 'MED', nameEn: 'Paracetamol', nameAr: 'باراسيتامول', tracking: 'batch', requiresExpiry: true, salePrice: 2000 });
    const noExpiry = await c.raw('POST', '/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-02-01', post: true,
      lines: [{ itemId: medicine, quantity: 10000, unitPrice: 1000, ext: { lots: [{ lotNo: 'L1', qty: 10000 }] } }],
    });
    assert.equal(noExpiry.body.error.code, 'stock.expiry_required');
    const noLots = await c.raw('POST', '/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-02-01', post: true,
      lines: [{ itemId: medicine, quantity: 10000, unitPrice: 1000 }],
    });
    assert.equal(noLots.body.error.code, 'stock.lot_required');
    await bill([
      { itemId: medicine, quantity: 20000, unitPrice: 1000, ext: { lots: [{ lotNo: 'L1', expiry: '2026-06-30', qty: 10000 }, { lotNo: 'L2', expiry: '2026-12-31', qty: 10000 }] } },
    ]);
    const lots = (await card(medicine)).lots;
    assert.deepEqual(lots.map((l: any) => [l.lot_no, l.qty]), [['L1', 10000], ['L2', 10000]]);
    await reconciled();
  });

  test('sales pick the lot that expires first (FEFO)', async () => {
    const id = await invoice([{ itemId: medicine, quantity: 12000, unitPrice: 2000 }], { date: '2026-05-01' });
    const moves = await c.get(`/api/inventory/by-source?type=sales_invoice&id=${id}`);
    assert.deepEqual(moves.map((m: any) => [m.lot_no, m.qty]), [['L1', -10000], ['L2', -2000]]);
  });

  test('expired lots cannot be sold, and are skipped automatically', async () => {
    await bill([{ itemId: medicine, quantity: 5000, unitPrice: 1000, ext: { lots: [{ lotNo: 'L0', expiry: '2026-07-15', qty: 5000 }] } }], { date: '2026-05-02' });
    const res = await c.raw('POST', '/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-08-01', post: true,
      lines: [{ itemId: medicine, quantity: 1000, unitPrice: 2000, ext: { lots: [{ lotNo: 'L0', qty: 1000 }] } }],
    });
    assert.equal(res.body.error.code, 'stock.lot_expired');
    const id = await invoice([{ itemId: medicine, quantity: 1000, unitPrice: 2000 }], { date: '2026-08-01' });
    const moves = await c.get(`/api/inventory/by-source?type=sales_invoice&id=${id}`);
    assert.equal(moves[0].lot_no, 'L2', 'expired L0 skipped');
    const exp = await c.get('/api/inventory/reports/expiry?days=365');
    assert.ok(exp.rows.some((r: any) => r.lot_no === 'L0'));
    await reconciled();
  });

  test('customer returns go back into the lot they were sold from', async () => {
    const inv = await invoice([{ itemId: medicine, quantity: 2000, unitPrice: 2000 }], { date: '2026-08-02' });
    const cn = await c.post('/api/documents', {
      kind: 'sales_credit', partyId: customer, date: '2026-08-03', againstDocumentId: inv, post: true,
      lines: [{ itemId: medicine, quantity: 1000, unitPrice: 2000 }],
    });
    const moves = await c.get(`/api/inventory/by-source?type=sales_credit&id=${cn.id}`);
    assert.equal(moves[0].lot_no, 'L2');
    await reconciled();
  });

  test('a lot-tracked physical count works lot by lot', async () => {
    const before = (await card(medicine)).lots.filter((l: any) => l.warehouse_id === main);
    const l2 = before.find((l: any) => l.lot_no === 'L2').qty;
    const l0 = before.find((l: any) => l.lot_no === 'L0').qty;
    // Found 1 less of L2, all of L0 written off, and a new lot L3.
    const { id } = await c.post('/api/inventory/operations', {
      kind: 'count', date: '2026-08-05', warehouseId: main, post: true,
      lines: [{ itemId: medicine, qty: l2 - 1000 + 3000, lots: [{ lotNo: 'L2', qty: l2 - 1000 }, { lotNo: 'L3', expiry: '2027-03-31', qty: 3000 }], unitCost: 1100 }],
    });
    const after = (await card(medicine)).lots;
    assert.equal(after.find((l: any) => l.lot_no === 'L2').qty, l2 - 1000);
    assert.equal(after.find((l: any) => l.lot_no === 'L3').qty, 3000);
    assert.ok(!after.some((l: any) => l.lot_no === 'L0'), `L0 (${l0}) written off`);
    assert.ok(id);
    await reconciled();
  });

  // ---------------------------------------------------------- serials
  let phone: number;
  test('serial numbers: one unit each, never twice in stock, traceable', async () => {
    phone = await item({ sku: 'PHN', nameEn: 'Phone', nameAr: 'موبايل', tracking: 'serial', salePrice: 1000000 });
    const serials = ['SN-001', 'SN-002', 'SN-003'];
    const b = await bill([{ itemId: phone, quantity: 3000, unitPrice: 700000, ext: { lots: serials.map((s) => ({ lotNo: s, qty: 1000 })) } }]);
    const dup = await c.raw('POST', '/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-02-02', post: true,
      lines: [{ itemId: phone, quantity: 1000, unitPrice: 700000, ext: { lots: [{ lotNo: 'SN-002', qty: 1000 }] } }],
    });
    assert.equal(dup.body.error.code, 'stock.serial_in_stock');
    const inv = await invoice([{ itemId: phone, quantity: 1000, unitPrice: 1000000, ext: { lots: [{ lotNo: 'SN-002', qty: 1000 }] } }]);
    const trace = await c.get('/api/inventory/trace?q=SN-002');
    const moves = trace.lots[0].moves;
    assert.deepEqual(moves.map((m: any) => [m.source_type, m.source_id]), [['purchase_bill', b], ['sales_invoice', inv]]);
    assert.equal(moves[1].party_name, 'City Pharmacy');
    await reconciled();
  });

  // ----------------------------------------- purchase orders, receipts, GRNI
  let po: number;
  let receipt: number;
  let widget: number;
  test('purchase order → goods receipt: stock arrives before the invoice (GRNI)', async () => {
    widget = await item({ sku: 'WDG', nameEn: 'Widget', nameAr: 'قطعة', purchasePrice: 5000, salePrice: 9000 });
    po = (await c.post('/api/purchase-orders', { supplierId: supplier, date: '2026-04-01', approve: true, lines: [{ itemId: widget, quantity: 10000, unitPrice: 5000 }] })).id;
    const order = await c.get(`/api/purchase-orders/${po}`);
    assert.equal(order.number, 'PO-00001');
    assert.equal(order.status, 'open');
    const poLine = order.lines[0].id;
    receipt = (await c.post('/api/inventory/receipts', {
      supplierId: supplier, poId: po, date: '2026-04-05', warehouseId: main, post: true,
      lines: [{ itemId: widget, quantity: 10000, unitCost: 5000, poLineId: poLine }],
    })).id;
    const rc = await c.get(`/api/inventory/receipts/${receipt}`);
    assert.equal(rc.number, 'GRN-00001');
    assert.equal(await level(widget), 10000);
    const je = await c.get(`/api/journal/${rc.journal_entry_id}`);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['2160']).credit, 50000);
    assert.equal((await c.get(`/api/purchase-orders/${po}`)).lines[0].received_base, 10000);
    const over = await c.raw('POST', '/api/inventory/receipts', {
      supplierId: supplier, poId: po, date: '2026-04-06', warehouseId: main, post: true,
      lines: [{ itemId: widget, quantity: 1000, unitCost: 5000, poLineId: poLine }],
    });
    assert.equal(over.body.error.code, 'po.over_quantity');
    // An order line only counts goods of its own item.
    const other = await item({ sku: 'WDG-X', nameEn: 'Other widget', nameAr: 'قطعة أخرى' });
    const wrong = await c.raw('POST', '/api/inventory/receipts', {
      supplierId: supplier, poId: po, date: '2026-04-06', warehouseId: main, post: true,
      lines: [{ itemId: other, quantity: 1000, unitCost: 5000, poLineId: poLine }],
    });
    assert.equal(wrong.body.error.code, 'po.other_item');
    await reconciled();
  });

  let widgetBill: number;
  test('the supplier invoice clears GRNI; a higher price revalues stock on hand', async () => {
    await invoice([{ itemId: widget, quantity: 4000, unitPrice: 9000 }], { date: '2026-04-07' });
    const rc = await c.get(`/api/inventory/receipts/${receipt}`);
    const poLine = (await c.get(`/api/purchase-orders/${po}`)).lines[0].id;
    widgetBill = await bill(
      [{ itemId: widget, quantity: 10000, unitPrice: 5500, ext: { receiptLineId: rc.lines[0].id, poLineId: poLine } }],
      { date: '2026-04-10' },
    );
    const b = await c.get(`/api/documents/${widgetBill}`);
    assert.equal(b.lines[0].account_id, ids['2160'], 'booked to GRNI automatically');
    assert.equal(await level(widget), 6000, 'no double receipt');
    // 5,000 price difference: 6/10 still on hand -> inventory 3,000, 4/10 already sold -> COGS 2,000
    const w = await card(widget);
    assert.equal(w.value, 30000 + 3000);
    const grni = await c.get('/api/inventory/reports/grni');
    assert.equal(grni.open, 0);
    assert.equal(grni.ledger, 0);
    const order = await c.get(`/api/purchase-orders/${po}`);
    assert.equal(order.status, 'closed', 'fully received and invoiced');
    await reconciled();
  });

  test('voiding the invoice re-opens GRNI and the order', async () => {
    await c.post(`/api/documents/${widgetBill}/void`, {});
    const grni = await c.get('/api/inventory/reports/grni');
    assert.equal(grni.open, 50000);
    assert.equal(grni.ledger, 50000);
    assert.equal((await c.get(`/api/purchase-orders/${po}`)).status, 'open');
    // 4 of the 10 received widgets were sold since: the receipt can no longer be taken back.
    const res = await c.raw('POST', `/api/inventory/receipts/${receipt}/void`, {});
    assert.equal(res.body.error.code, 'stock.insufficient');
    await reconciled();
  });

  // ---------------------------------------------------------- landed costs
  test('landed costs raise the cost of goods on hand; the sold part goes to COGS', async () => {
    const gadget = await item({ sku: 'GDG', nameEn: 'Gadget', nameAr: 'جهاز', salePrice: 30000 });
    const b = await bill([{ itemId: gadget, quantity: 10000, unitPrice: 20000 }], { date: '2026-05-01' });
    await invoice([{ itemId: gadget, quantity: 2000, unitPrice: 30000 }], { date: '2026-05-02' });
    const clearing = await acc(c, '2130');
    const lc = await c.post('/api/inventory/landed-costs', {
      date: '2026-05-03', counterAccountId: clearing, amount: 10000, method: 'value', post: true,
      targets: [{ sourceType: 'purchase_bill', sourceId: b }],
    });
    const view = await c.get(`/api/inventory/landed-costs/${lc.id}`);
    assert.equal(view.number, 'LC-00001');
    const blocked = await c.raw('POST', `/api/documents/${b}/void`, {});
    assert.equal(blocked.body.error.code, 'landed.has_costs', 'a bill carrying landed costs cannot be voided first');
    assert.equal(view.allocations[0].to_inventory, 8000);
    assert.equal(view.allocations[0].to_cogs, 2000);
    assert.equal((await card(gadget)).value, 160000 + 8000);
    await reconciled();
    await c.post(`/api/inventory/landed-costs/${lc.id}/void`, {});
    assert.equal((await card(gadget)).value, 160000);
    await reconciled();
  });

  test('an unbilled receipt with its goods still in stock can be voided cleanly', async () => {
    const gear = await item({ sku: 'GEAR', nameEn: 'Gear', nameAr: 'ترس' });
    const clearing = await acc(c, '2130');
    const r = (await c.post('/api/inventory/receipts', {
      supplierId: supplier, date: '2026-05-10', warehouseId: main, post: true,
      lines: [{ itemId: gear, quantity: 4000, unitCost: 2500 }],
    })).id;
    const lc = await c.post('/api/inventory/landed-costs', {
      date: '2026-05-11', counterAccountId: clearing, amount: 2000, method: 'qty', post: true,
      targets: [{ sourceType: 'goods_receipt', sourceId: r }],
    });
    assert.equal((await card(gear)).value, 12000);
    // The freight must go first: otherwise its value would stay in stock with no goods left.
    const blocked = await c.raw('POST', `/api/inventory/receipts/${r}/void`, {});
    assert.equal(blocked.body.error.code, 'landed.has_costs');
    await c.post(`/api/inventory/landed-costs/${lc.id}/void`, {});
    await c.post(`/api/inventory/receipts/${r}/void`, {});
    assert.equal(await level(gear), 0);
    assert.equal((await card(gear)).value, 0);
    await reconciled();
  });

  // --------------------------------------------------------- back-dating
  test('a back-dated purchase re-costs later sales automatically', async () => {
    const bolt = await item({ sku: 'BLT', nameEn: 'Bolt', nameAr: 'مسمار', salePrice: 5000 });
    await bill([{ itemId: bolt, quantity: 10000, unitPrice: 1000 }], { date: '2026-06-01' });
    await invoice([{ itemId: bolt, quantity: 5000, unitPrice: 5000 }], { date: '2026-06-10' });
    assert.equal((await card(bolt)).value, 5000);
    // Forgotten invoice from the 5th, more expensive: the sale on the 10th should have cost more.
    await bill([{ itemId: bolt, quantity: 5000, unitPrice: 2000 }], { date: '2026-06-05' });
    const after = await card(bolt);
    assert.equal(after.qty, 10000);
    assert.equal(after.value, 13333); // ideal: 20,000 x 10/15
    const reval = c.app.kernel.db.get<{ n: number }>("SELECT COUNT(*) n FROM journal_entries WHERE source_type = 'stock_revaluation'")!;
    assert.ok(reval.n >= 1);
    await reconciled();
  });

  test('a back-dated sale cannot use stock that had not arrived yet', async () => {
    const nut = await item({ sku: 'NUT', nameEn: 'Nut', nameAr: 'صامولة', salePrice: 100 });
    await bill([{ itemId: nut, quantity: 10000, unitPrice: 50 }], { date: '2026-07-10' });
    const res = await c.raw('POST', '/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-07-01', post: true,
      lines: [{ itemId: nut, quantity: 1000, unitPrice: 100 }],
    });
    assert.equal(res.body.error.code, 'stock.insufficient');
    assert.equal(res.body.error.details.asOf, '2026-07-01');
  });

  // -------------------------------------------------------------- pricing
  test('price lists and the minimum selling price', async () => {
    const soap = await item({ sku: 'SOAP', nameEn: 'Soap', nameAr: 'صابون', salePrice: 1000, minSalePrice: 800,
      units: [{ nameEn: 'Pack', nameAr: 'باكو', factor: 6000 }] });
    await bill([{ itemId: soap, quantity: 100000, unitPrice: 500 }]);
    const pack = (await card(soap)).units[0].id;
    const list = await c.post('/api/pricing/lists', {
      nameEn: 'Wholesale', nameAr: 'جملة', partyIds: [customer],
      prices: [{ itemId: soap, price: 850 }, { itemId: soap, unitId: pack, price: 4800 }],
    });
    const forParty = await c.get(`/api/pricing/for-party/${customer}`);
    assert.equal(forParty.list.id, list.id);
    assert.equal(forParty.prices[`${soap}:0`], 850);
    assert.equal(forParty.prices[`${soap}:${pack}`], 4800);

    await c.post('/api/users', { username: 'acct', displayName: 'Accountant', role: 'accountant', password: 'password123' });
    const acct = await c.login('acct', 'password123');
    const low = await c.raw('POST', '/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-03-05', post: true,
      lines: [{ itemId: soap, unitId: pack, quantity: 1000, unitPrice: 4200 }], // 700 per piece
    }, acct);
    assert.equal(low.body.error.code, 'price.below_minimum');
    const ok = await c.raw('POST', '/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-03-05', post: true,
      lines: [{ itemId: soap, unitId: pack, quantity: 1000, unitPrice: 4800 }],
    }, acct);
    assert.equal(ok.status, 200);
    // Administrators may override.
    await invoice([{ itemId: soap, quantity: 1000, unitPrice: 700 }], { date: '2026-03-06' });
    await reconciled();
  });
});
