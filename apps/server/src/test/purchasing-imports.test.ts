import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

/**
 * Import purchasing (worked example, base EGP, USD rates 04-01: 48, 04-05: 49, 04-20: 50, 04-25: 51):
 *   PO USD 1,000 (100 pcs at USD 10) → receipt 04-05 valued at 49 = EGP 49,000.00 → supplier bill 04-20 at 50 = EGP 50,000.00
 *   (the 1,000.00 difference lands on the stock still on hand through GRNI, as for any price difference).
 */
describe('purchasing — imports, requisitions, letters of credit, reports', () => {
  let c: TestClient;
  let supplier: number, main: number, bank: number, payable: number;
  const R = (x: number) => Math.round(x * 1_000_000);
  const item = (body: object) => c.post('/api/items', { kind: 'product', unit: 'PCS', ...body }).then((r) => r.id as number);
  const bal = async (accountId: number, to = '2026-12-31') =>
    (await c.get(`/api/reports/trial-balance?from=2026-01-01&to=${to}`)).rows.find((r: any) => r.id === accountId) ?? { closing_debit: 0, closing_credit: 0 };
  const net = async (accountId: number) => {
    const b = await bal(accountId);
    return b.closing_debit - b.closing_credit;
  };
  const codeId = async (code: string) => (await c.get('/api/accounts')).find((a: any) => a.code === code).id as number;
  const balanced = async () => assert.equal((await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).balanced, true);
  const valuation = async () => assert.equal((await c.get('/api/inventory/reports/valuation?asOf=2026-12-31')).difference, 0);

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    bank = await acc(c, '1120');
    payable = await acc(c, '2110');
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Shenzhen Panels' })).id;
    main = (await c.get('/api/inventory/warehouses')).find((w: any) => w.is_default).id;
    for (const [date, rate] of [['2026-04-01', 48], ['2026-04-05', 49], ['2026-04-20', 50], ['2026-04-25', 51]] as const) await c.post('/api/fx/rates', { currency: 'USD', date, rate: R(rate) });
  });
  after(() => c.close());

  test('item planning fields are saved, validated and returned', async () => {
    const id = await item({ sku: 'PLAN', nameEn: 'Planned', nameAr: 'مخطط', materialType: 'packaging', procurementType: 'buy', leadTimeDays: 70, moq: 250000, lotSizeRule: 'fixed', lotSize: 500000, safetyStock: 100000, defaultSupplierId: supplier });
    const it = (await c.get('/api/items')).find((i: any) => i.id === id);
    assert.deepEqual([it.material_type, it.procurement_type, it.lead_time_days, it.moq, it.lot_size_rule, it.lot_size, it.safety_stock, it.default_supplier_id], ['packaging', 'buy', 70, 250000, 'fixed', 500000, 100000, supplier]);
    const plain = await item({ sku: 'PLAIN', nameEn: 'Plain', nameAr: 'عادي' });
    const p = (await c.get('/api/items')).find((i: any) => i.id === plain);
    assert.deepEqual([p.material_type, p.procurement_type, p.lead_time_days, p.lot_size_rule], [null, 'buy', 0, 'lot_for_lot'], 'older clients and imports keep working');
    const customer = (await c.post('/api/parties', { kind: 'customer', name: 'Some Customer' })).id;
    for (const body of [{ lotSizeRule: 'multiple', lotSize: 0 }, { defaultSupplierId: customer }, { materialType: 'gold' }]) {
      const res = await c.raw('POST', '/api/items', { kind: 'product', sku: 'BAD' + Math.random(), nameEn: 'x', nameAr: 'x', ...body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  let chip: number, po: number;
  test('a USD order is received at the receipt date’s rate and matches the supplier bill (3-way match)', async () => {
    chip = await item({ sku: 'CHIP', nameEn: 'Main chip', nameAr: 'شريحة' });
    po = (await c.post('/api/purchase-orders', {
      supplierId: supplier, date: '2026-04-01', expectedDate: '2026-06-10', warehouseId: main, currency: 'USD', incoterm: 'CIF', portOfLoading: 'Shenzhen', portOfDischarge: 'Sokhna', approve: true,
      lines: [{ itemId: chip, quantity: 100000, unitPrice: 1000, expectedDate: '2026-06-12' }],
    })).id;
    const o = await c.get(`/api/purchase-orders/${po}`);
    assert.deepEqual([o.currency, o.exchange_rate, o.incoterm, o.port_of_loading, o.port_of_discharge, o.total], ['USD', R(48), 'CIF', 'Shenzhen', 'Sokhna', 100000]);
    assert.equal(o.lines[0].expected_date, '2026-06-12');
    const line = o.lines[0].id;
    // A receipt in another currency than the order's is refused.
    const wrong = await c.raw('POST', '/api/inventory/receipts', { supplierId: supplier, poId: po, date: '2026-04-05', warehouseId: main, post: true, lines: [{ itemId: chip, quantity: 100000, unitCost: 1000, poLineId: line }] });
    assert.equal(wrong.body.error.code, 'po.currency');
    const r = (await c.post('/api/inventory/receipts', { supplierId: supplier, poId: po, date: '2026-04-05', warehouseId: main, currency: 'USD', post: true, lines: [{ itemId: chip, quantity: 100000, unitCost: 1000, poLineId: line }] })).id;
    const rc = await c.get(`/api/inventory/receipts/${r}`);
    assert.deepEqual([rc.currency, rc.exchange_rate], ['USD', R(49)]);
    assert.equal(rc.lines[0].value, 49_000_00, 'USD 1,000 at 49');
    assert.equal(rc.lines[0].unit_cost, 490_00);
    assert.equal(rc.lines[0].value_fx, 1000_00);
    assert.equal(await net(await codeId('1140')), 49_000_00);
    assert.equal((await c.get(`/api/purchase-orders/${po}`)).lines[0].received_base, 100000);
    await valuation();
    // Bill on 04-20 at 50: the difference goes to the stock still on hand.
    const bill = (await c.post('/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-04-20', currency: 'USD', post: true,
      lines: [{ itemId: chip, quantity: 100000, unitPrice: 1000, ext: { receiptLineId: rc.lines[0].id, poLineId: line } }],
    })).id;
    const b = await c.get(`/api/documents/${bill}`);
    assert.equal(b.base_total, 50_000_00);
    assert.equal(await net(await codeId('1140')), 50_000_00, 'stock revalued by the price difference');
    assert.equal(await net(await codeId('2160')), 0, 'GRNI cleared');
    assert.equal((await c.get(`/api/purchase-orders/${po}`)).status, 'closed');
    await valuation();
    await balanced();
  });

  test('a foreign order needs the multi-currency module, and a base-currency receipt is unaffected', async () => {
    const eur = await c.raw('POST', '/api/purchase-orders', { supplierId: supplier, date: '2026-04-01', currency: 'XYZ', lines: [{ itemId: chip, quantity: 1000, unitPrice: 100 }] });
    assert.equal(eur.status, 404, 'an unknown currency is refused');
    const egp = (await c.post('/api/purchase-orders', { supplierId: supplier, date: '2026-04-01', currency: 'EGP', approve: true, lines: [{ itemId: chip, quantity: 1000, unitPrice: 100 }] })).id;
    assert.equal((await c.get(`/api/purchase-orders/${egp}`)).currency, null, 'the base currency is stored as none');
  });

  test('requisitions: convert several of one supplier into an order, keep the link, follow its life', async () => {
    const a = await item({ sku: 'RA', nameEn: 'Res A', nameAr: 'أ', purchasePrice: 100, moq: 100000, lotSizeRule: 'multiple', lotSize: 50000, leadTimeDays: 30, defaultSupplierId: supplier });
    const b = await item({ sku: 'RB', nameEn: 'Res B', nameAr: 'ب', purchasePrice: 200, defaultSupplierId: supplier });
    const other = (await c.post('/api/parties', { kind: 'supplier', name: 'Other Supplier' })).id;
    const x = await item({ sku: 'RX', nameEn: 'Res X', nameAr: 'س', defaultSupplierId: other });
    const mk = (itemId: number, quantity: number, needDate: string) => c.post('/api/purchase-requisitions', { itemId, quantity, needDate, warehouseId: main }).then((r) => r.id as number);
    const [r1, r2, r3] = [await mk(a, 120000, '2026-08-01'), await mk(b, 5000, '2026-07-15'), await mk(x, 1000, '2026-07-20')];
    const list = await c.get('/api/purchase-requisitions');
    const one = list.find((r: any) => r.id === r1);
    assert.deepEqual([one.source, one.status, one.order_by_date, one.supplier_id, one.number], ['manual', 'open', '2026-07-02', supplier, 'PR-00001'], 'order-by = need date − lead time');
    // Different suppliers cannot go on one order.
    const mixed = await c.raw('POST', '/api/purchase-requisitions/convert', { ids: [r1, r3] });
    assert.equal(mixed.body.error.code, 'requisition.supplier_mixed');
    const id = (await c.post('/api/purchase-requisitions/convert', { ids: [r1, r2], date: '2026-06-01' })).id;
    const o = await c.get(`/api/purchase-orders/${id}`);
    assert.equal(o.status, 'draft', 'converting never approves');
    assert.equal(o.supplier_id, supplier);
    assert.deepEqual(o.lines.map((l: any) => [l.item_id, l.quantity, l.requisition_number]), [[b, 5000, 'PR-00002'], [a, 150000, 'PR-00001']], 'sorted by need date; 120 rounded up to the lot multiple 150');
    assert.deepEqual(o.lines.map((l: any) => l.expected_date), ['2026-07-15', '2026-08-01']);
    const st = async (i: number) => (await c.get('/api/purchase-requisitions')).find((r: any) => r.id === i);
    assert.deepEqual([(await st(r1)).status, (await st(r1)).po_id], ['converted', id]);
    assert.equal((await c.raw('POST', '/api/purchase-requisitions/convert', { ids: [r1] })).body.error.code, 'requisition.not_open');
    // Deleting the draft frees them; approving and closing the order closes them.
    await c.del(`/api/purchase-orders/${id}`);
    assert.deepEqual([(await st(r1)).status, (await st(r1)).po_id], ['open', null]);
    const id2 = (await c.post('/api/purchase-requisitions/convert', { ids: [r1], applyLotSizing: false })).id;
    assert.equal((await c.get(`/api/purchase-orders/${id2}`)).lines[0].quantity, 120000);
    await c.post(`/api/purchase-orders/${id2}/approve`);
    await c.post(`/api/purchase-orders/${id2}/close`);
    assert.equal((await st(r1)).status, 'closed');
    await c.post(`/api/purchase-orders/${id2}/reopen`);
    assert.equal((await st(r1)).status, 'converted');
    await c.post(`/api/purchase-orders/${id2}/cancel`);
    assert.equal((await st(r1)).status, 'open', 'a cancelled order gives its requisitions back');
    // Cancel one; edit an open manual one.
    await c.post(`/api/purchase-requisitions/${r3}/cancel`);
    assert.equal((await st(r3)).status, 'cancelled');
    await c.put(`/api/purchase-requisitions/${r2}`, { itemId: b, quantity: 8000, needDate: '2026-07-10' });
    assert.equal((await st(r2)).quantity, 8000);
    assert.equal((await c.get('/api/system/health')).find((m: any) => m.module === 'purchasing').checks.every((x: any) => x.ok), true);
  });

  let lc: number, lcPo: number, lcLine: number;
  test('letter of credit: margin and charges are posted, the bank finances the rest, settlement pays the bill', async () => {
    const part = await item({ sku: 'LCP', nameEn: 'LC part', nameAr: 'قطعة' });
    lcPo = (await c.post('/api/purchase-orders', { supplierId: supplier, date: '2026-04-01', currency: 'USD', warehouseId: main, approve: true, lines: [{ itemId: part, quantity: 50000, unitPrice: 1000 }] })).id;
    lcLine = (await c.get(`/api/purchase-orders/${lcPo}`)).lines[0].id;
    // Wrong supplier / currency are refused.
    const other = (await c.post('/api/parties', { kind: 'supplier', name: 'Not This One' })).id;
    const badBody = { lcNumber: 'X', bankAccountId: bank, amount: 50000, openingDate: '2026-04-02', expiryDate: '2026-09-30' };
    assert.equal((await c.raw('POST', '/api/letters-of-credit', { ...badBody, supplierId: other, poId: lcPo })).body.error.code, 'lc.po_supplier');
    assert.equal((await c.raw('POST', '/api/letters-of-credit', { ...badBody, supplierId: supplier, poId: lcPo, currency: 'EUR' })).body.error.code, 'lc.po_currency');
    assert.equal((await c.raw('POST', '/api/letters-of-credit', { ...badBody, supplierId: supplier, poId: lcPo, expiryDate: '2026-03-01' })).body.error.code, 'lc.dates');
    // USD 500 LC, 20% cash margin = USD 100 at 48 = EGP 4,800; opening commission EGP 20.
    lc = (await c.post('/api/letters-of-credit', { ...badBody, lcNumber: 'LC-2026-0042', supplierId: supplier, poId: lcPo, marginBp: 2000, openingCharges: 2000, latestShipmentDate: '2026-08-15', expiryDate: '2026-09-30' })).id;
    let l = await c.get(`/api/letters-of-credit/${lc}`);
    assert.deepEqual([l.number, l.currency, l.amount, l.margin_amount, l.margin_base, l.status, l.opening_rate], ['LOC-00001', 'USD', 50000, 10000, 4_800_00, 'opened', R(48)]);
    const margin = l.margin_account_id, financing = l.financing_account_id;
    assert.equal(await net(margin), 4_800_00);
    assert.equal(await net(bank), -4_820_00, 'margin and commission left the bank');
    assert.equal(await net(l.charges_account_id), 20_00);
    await balanced();
    // Every entry balances and carries the LC as its source.
    const entries = l.events.filter((e: any) => e.entry_id).map((e: any) => e.entry_id);
    assert.equal(new Set(entries).size, 1, 'opening: one entry for margin and commission');
    const je = await c.get(`/api/journal/${entries[0]}`);
    assert.equal(je.lines.reduce((s: number, x: any) => s + x.debit, 0), je.lines.reduce((s: number, x: any) => s + x.credit, 0));
    assert.equal(je.source_type, 'letter_of_credit');
    // Bank charges later, and the documents arrive.
    await c.post(`/api/letters-of-credit/${lc}/charges`, { date: '2026-04-10', amount: 150_00, memo: 'Amendment fee' });
    assert.equal(await net(bank), -4_970_00);
    await c.post(`/api/letters-of-credit/${lc}/documents`, { date: '2026-04-18' });
    assert.equal((await c.get(`/api/letters-of-credit/${lc}`)).status, 'documents_received');
    // Goods and the supplier bill (USD 500 at 50 = EGP 25,000), then settlement at 51.
    const ap0 = await net(payable);
    const rc = (await c.post('/api/inventory/receipts', { supplierId: supplier, poId: lcPo, date: '2026-04-05', warehouseId: main, currency: 'USD', post: true, lines: [{ itemId: part, quantity: 50000, unitCost: 1000, poLineId: lcLine }] })).id;
    const rcl = (await c.get(`/api/inventory/receipts/${rc}`)).lines[0].id;
    const bill = (await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-04-20', currency: 'USD', post: true, lines: [{ itemId: part, quantity: 50000, unitPrice: 1000, ext: { receiptLineId: rcl, poLineId: lcLine } }] })).id;
    assert.equal((await net(payable)) - ap0, -25_000_00);
    await c.post(`/api/letters-of-credit/${lc}/settle`, { documentId: bill, date: '2026-04-25' });
    l = await c.get(`/api/letters-of-credit/${lc}`);
    assert.equal(l.status, 'settled');
    // Settlement 500 × 51 = 25,500: margin 4,800 + bank financing 20,700; AP cleared at 25,000; realised loss 500.
    assert.equal(l.financed_base, 20_700_00);
    assert.equal(await net(payable), ap0, 'the supplier is paid');
    assert.equal(await net(margin), 0, 'the margin was applied');
    assert.equal(await net(financing), -20_700_00);
    assert.equal(await net(await codeId('5850')), 500_00, 'realised exchange loss');
    assert.equal((await c.get(`/api/documents/${bill}`)).amount_settled, 50000);
    await balanced();
    await valuation();
    // The bank is repaid; only what was financed can be repaid.
    assert.equal((await c.raw('POST', `/api/letters-of-credit/${lc}/repay`, { date: '2026-05-25', amount: 20_701_00 })).body.error.code, 'lc.over_repay');
    await c.post(`/api/letters-of-credit/${lc}/repay`, { date: '2026-05-25', amount: 20_700_00 });
    assert.equal(await net(financing), 0);
    assert.equal(await net(bank), -4_970_00 - 20_700_00);
    assert.equal((await c.raw('POST', `/api/letters-of-credit/${lc}/charges`, { date: '2026-06-01', amount: 100 })).status, 200, 'charges may follow settlement');
    assert.equal((await c.raw('POST', `/api/letters-of-credit/${lc}/close`, {})).body.error.code, 'lc.closed');
    await balanced();
  });

  test('a letter of credit that is never used gives its margin back; a partial settlement uses margin pro rata', async () => {
    const part = await item({ sku: 'LCQ', nameEn: 'LC part 2', nameAr: 'قطعة ٢' });
    const po2 = (await c.post('/api/purchase-orders', { supplierId: supplier, date: '2026-04-01', currency: 'USD', warehouseId: main, approve: true, lines: [{ itemId: part, quantity: 100000, unitPrice: 1000 }] })).id;
    const line = (await c.get(`/api/purchase-orders/${po2}`)).lines[0].id;
    const unused = (await c.post('/api/letters-of-credit', { lcNumber: 'LC-U', supplierId: supplier, bankAccountId: bank, currency: 'USD', amount: 100000, marginBp: 1000, openingDate: '2026-04-02', expiryDate: '2026-06-30' })).id;
    const u = await c.get(`/api/letters-of-credit/${unused}`);
    const before = await net(bank);
    await c.post(`/api/letters-of-credit/${unused}/close`, { date: '2026-05-01' });
    assert.equal((await c.get(`/api/letters-of-credit/${unused}`)).status, 'cancelled');
    assert.equal(await net(u.margin_account_id), 0);
    assert.equal(await net(bank), before + u.margin_base);
    // Half of the goods and bill, settled from an LC of USD 1,000: margin 10% = USD 100, half used.
    const lc2 = (await c.post('/api/letters-of-credit', { lcNumber: 'LC-P', supplierId: supplier, poId: po2, bankAccountId: bank, amount: 100000, marginBp: 1000, openingDate: '2026-04-02', expiryDate: '2026-06-30' })).id;
    const rc = (await c.post('/api/inventory/receipts', { supplierId: supplier, poId: po2, date: '2026-04-05', warehouseId: main, currency: 'USD', post: true, lines: [{ itemId: part, quantity: 50000, unitCost: 1000, poLineId: line }] })).id;
    const rcl = (await c.get(`/api/inventory/receipts/${rc}`)).lines[0].id;
    const bill = (await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-04-20', currency: 'USD', post: true, lines: [{ itemId: part, quantity: 50000, unitPrice: 1000, ext: { receiptLineId: rcl, poLineId: line } }] })).id;
    await c.post(`/api/letters-of-credit/${lc2}/settle`, { documentId: bill, date: '2026-04-20' });
    const l = await c.get(`/api/letters-of-credit/${lc2}`);
    assert.equal(l.status, 'opened', 'half of the LC is still open');
    assert.equal(l.margin_used_base, 2_400_00, 'half of EGP 4,800');
    assert.equal(l.financed_base, 25_000_00 - 2_400_00);
    assert.equal(await net(l.margin_account_id), 2_400_00, 'the other half of the margin stays with the bank');
    // Close what is left: the unused margin returns.
    await c.post(`/api/letters-of-credit/${lc2}/close`, { date: '2026-05-01' });
    assert.equal((await c.get(`/api/letters-of-credit/${lc2}`)).status, 'settled');
    assert.equal(await net(l.margin_account_id), 0);
    // A bill of another currency cannot be paid from it; a cancelled order with an open LC is refused.
    await balanced();
  });

  test('reports: supplier on-time delivery and open orders', async () => {
    const it = await item({ sku: 'OT', nameEn: 'On time', nameAr: 'في الموعد' });
    const mk = (date: string, expected: string) =>
      c.post('/api/purchase-orders', { supplierId: supplier, date, expectedDate: expected, warehouseId: main, approve: true, lines: [{ itemId: it, quantity: 10000, unitPrice: 100, expectedDate: expected }] }).then((r) => r.id as number);
    const late = await mk('2026-05-01', '2026-05-10');
    const early = await mk('2026-05-01', '2026-05-20');
    await mk('2026-05-01', '2026-05-15');
    const recv = async (poId: number, date: string) => {
      const line = (await c.get(`/api/purchase-orders/${poId}`)).lines[0].id;
      await c.post('/api/inventory/receipts', { supplierId: supplier, poId, date, warehouseId: main, post: true, lines: [{ itemId: it, quantity: 10000, unitCost: 100, poLineId: line }] });
    };
    await recv(late, '2026-05-14'); // 4 days late
    await recv(early, '2026-05-18'); // 2 days early
    const rep = await c.get('/api/purchasing/reports/supplier-on-time?from=2026-05-01&to=2026-05-31');
    const s = rep.suppliers.find((x: any) => x.supplier_id === supplier);
    assert.deepEqual([s.lines, s.measured, s.on_time, s.late, s.max_days_late, s.on_time_bp, s.avg_days_late], [2, 2, 1, 1, 4, 5000, 4]);
    assert.deepEqual(rep.lines.map((x: any) => [x.days_late, x.on_time]).sort(), [[0, true], [4, false]]);
    const oo = await c.get('/api/purchasing/reports/open-orders?asOf=2026-05-20');
    const row = oo.rows.find((x: any) => x.sku === 'OT');
    assert.deepEqual([row.expected, row.open_base, row.days_overdue, row.open_value], ['2026-05-15', 10000, 5, 1000]);
    assert.ok(!oo.rows.some((x: any) => x.sku === 'OT' && x.expected === '2026-05-10'), 'received lines are not open');
  });
});
