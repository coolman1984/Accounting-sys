import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

describe('inventory — perpetual stock with moving average cost', () => {
  let c: TestClient;
  let ids: Record<string, number>;
  let customer: number;
  let supplier: number;
  let vat: number;
  let laptop: number;
  let mouse: number;
  let main: number;
  let branch: number;

  /** The golden rule: the inventory accounts in the books always equal the stock valuation. */
  const reconciled = async (asOf = '2026-12-31') => {
    const v = await c.get(`/api/inventory/reports/valuation?asOf=${asOf}`);
    assert.equal(v.difference, 0, `ledger ${v.ledger} vs stock ${v.total}`);
    const db = c.app.kernel.db;
    const bad = db.all(
      `SELECT v.item_id FROM stock_values v
       WHERE v.qty <> (SELECT COALESCE(SUM(qty), 0) FROM stock_levels l WHERE l.item_id = v.item_id)
          OR v.qty <> (SELECT COALESCE(SUM(qty), 0) FROM stock_moves m WHERE m.item_id = v.item_id)
          OR v.value <> (SELECT COALESCE(SUM(value), 0) FROM stock_moves m WHERE m.item_id = v.item_id)`,
    );
    assert.deepEqual(bad, [], 'pools, levels and moves agree');
    const tb = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(tb.balanced, true);
    return v;
  };

  const level = async (item: number, wh: number) => (await c.get(`/api/inventory/levels?warehouseId=${wh}`))[item] ?? 0;
  const itemCard = (item: number) => c.get(`/api/inventory/items/${item}`);

  before(async () => {
    c = await setupCompany();
    ids = {};
    for (const code of ['1120', '1140', '5100', '5160', '3100', '4100']) ids[code] = await acc(c, code);
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Retail Co' })).id;
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Maker Ltd' })).id;
    vat = (await c.get('/api/taxes'))[0].id;
    laptop = (await c.post('/api/items', { sku: 'LAP', nameEn: 'Laptop', nameAr: 'لابتوب', kind: 'product', salePrice: 1500000, purchasePrice: 1000000, reorderLevel: 3000, reorderQty: 10000 })).id;
    mouse = (await c.post('/api/items', { sku: 'MOU', nameEn: 'Mouse', nameAr: 'ماوس', kind: 'product', salePrice: 30000, barcode: '6221234567890' })).id;
    const whs = await c.get('/api/inventory/warehouses');
    main = whs.find((w: any) => w.code === 'MAIN').id;
    branch = (await c.post('/api/inventory/warehouses', { code: 'ALX', nameEn: 'Alexandria', nameAr: 'الإسكندرية' })).id;
  });
  after(() => c.close());

  test('a default warehouse exists and new companies get an adjustments account', async () => {
    const meta = await c.get('/api/accounts/meta');
    assert.equal(meta.defaults.inventoryAdjustment, ids['5160']);
    assert.ok(main);
  });

  test('buying stock debits inventory (not purchases) and receives the goods', async () => {
    const { id } = await c.post('/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-02-01', post: true,
      lines: [{ itemId: laptop, quantity: 10000, unitPrice: 1000000, taxId: vat }],
    });
    const bill = await c.get(`/api/documents/${id}`);
    assert.equal(bill.lines[0].account_id, ids['1140']);
    assert.equal(await level(laptop, main), 10000);
    const card = await itemCard(laptop);
    assert.equal(card.value, 10_000_000);
    assert.equal(card.avg_cost, 1_000_000);
    await reconciled();
  });

  test('a second purchase at a new price moves the weighted average', async () => {
    await c.post('/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-02-10', post: true, warehouseId: main,
      lines: [{ itemId: laptop, quantity: 5000, unitPrice: 1300000 }],
    });
    const card = await itemCard(laptop);
    assert.equal(card.qty, 15000);
    assert.equal(card.value, 16_500_000);
    assert.equal(card.avg_cost, 1_100_000); // (10 x 10,000 + 5 x 13,000) / 15
    await reconciled();
  });

  let invoice: number;
  test('selling posts cost of goods sold at average cost automatically', async () => {
    const { id } = await c.post('/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-03-01', post: true,
      lines: [{ itemId: laptop, quantity: 4000, unitPrice: 1500000, taxId: vat }],
    });
    invoice = id;
    assert.equal(await level(laptop, main), 11000);
    const moves = await c.get(`/api/inventory/by-source?type=sales_invoice&id=${id}`);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].value, -4_400_000);
    const je = await c.get(`/api/journal/${moves[0].journal_entry_id}`);
    assert.equal(je.source_type, 'cogs');
    assert.equal(je.lines.find((l: any) => l.account_id === ids['5100']).debit, 4_400_000);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['1140']).credit, 4_400_000);
    await reconciled();
  });

  test('stock can never go negative — the whole invoice is refused', async () => {
    const res = await c.raw('POST', '/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-03-02', post: true,
      lines: [{ itemId: laptop, quantity: 50000, unitPrice: 1500000 }],
    });
    assert.equal(res.body.error.code, 'stock.insufficient');
    assert.equal(res.body.error.details.available, 11);
    const drafts = await c.get('/api/documents?kind=sales_invoice');
    assert.equal(drafts.total, 1, 'nothing was saved');
    assert.equal(await level(laptop, main), 11000);
  });

  test('stock in another warehouse is not available here', async () => {
    const res = await c.raw('POST', '/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-03-02', post: true, warehouseId: branch,
      lines: [{ itemId: laptop, quantity: 1000, unitPrice: 1500000 }],
    });
    assert.equal(res.body.error.code, 'stock.insufficient');
  });

  test('transfers move quantity between warehouses without touching value or the books', async () => {
    const before = await itemCard(laptop);
    const { id } = await c.post('/api/inventory/operations', {
      kind: 'transfer', date: '2026-03-05', warehouseId: main, toWarehouseId: branch, post: true,
      lines: [{ itemId: laptop, qty: 3000 }],
    });
    const doc = await c.get(`/api/inventory/operations/${id}`);
    assert.equal(doc.number, 'TRF-00001');
    assert.equal(doc.journal_entry_id, null);
    assert.equal(await level(laptop, main), 8000);
    assert.equal(await level(laptop, branch), 3000);
    const after = await itemCard(laptop);
    assert.equal(after.value, before.value);
    await reconciled();
  });

  test('a customer return against an invoice comes back at its original cost', async () => {
    // Buy more at a different price first so the average changes.
    await c.post('/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-03-10', post: true,
      lines: [{ itemId: laptop, quantity: 4000, unitPrice: 1600000 }],
    });
    const { id } = await c.post('/api/documents', {
      kind: 'sales_credit', partyId: customer, date: '2026-03-12', againstDocumentId: invoice, post: true,
      lines: [{ itemId: laptop, quantity: 1000, unitPrice: 1500000 }],
    });
    const moves = await c.get(`/api/inventory/by-source?type=sales_credit&id=${id}`);
    assert.equal(moves[0].value, 1_100_000, 'same cost it left at');
    await reconciled();
  });

  test('returning goods to the supplier: price difference goes to cost of sales', async () => {
    const before = await itemCard(laptop);
    const { id } = await c.post('/api/documents', {
      kind: 'purchase_credit', partyId: supplier, date: '2026-03-15', post: true,
      lines: [{ itemId: laptop, quantity: 1000, unitPrice: 1600000 }],
    });
    const moves = await c.get(`/api/inventory/by-source?type=purchase_credit&id=${id}`);
    const avgOut = -moves[0].value;
    assert.equal(avgOut, Math.round((before.value * 1000) / before.qty));
    await reconciled();
  });

  test('physical count posts only the differences', async () => {
    const book = await level(laptop, main);
    const { id } = await c.post('/api/inventory/operations', {
      kind: 'count', date: '2026-04-01', warehouseId: main, post: true,
      lines: [{ itemId: laptop, qty: book - 2000 }],
    });
    const doc = await c.get(`/api/inventory/operations/${id}`);
    assert.equal(doc.lines[0].system_qty, book);
    assert.equal(await level(laptop, main), book - 2000);
    const je = await c.get(`/api/journal/${doc.journal_entry_id}`);
    assert.equal(je.source_type, 'stock_count');
    assert.ok(je.lines.find((l: any) => l.account_id === ids['5160']).debit > 0, 'shrinkage expensed');
    await reconciled();
  });

  test('opening stock at a given cost is booked against capital by default', async () => {
    const { id } = await c.post('/api/inventory/operations', {
      kind: 'opening', date: '2026-01-01', warehouseId: branch, post: true,
      lines: [{ itemId: mouse, qty: 100000, unitCost: 20000 }],
    });
    const doc = await c.get(`/api/inventory/operations/${id}`);
    const je = await c.get(`/api/journal/${doc.journal_entry_id}`);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['3100']).credit, 2_000_000);
    await reconciled();
  });

  test('adjustments up (at a cost) and down (at average)', async () => {
    await c.post('/api/inventory/operations', {
      kind: 'adjustment', date: '2026-04-05', warehouseId: branch, post: true, memo: 'Found & damaged',
      lines: [
        { itemId: mouse, qty: 5000, unitCost: 22000 },
        { itemId: mouse, qty: -2000 },
      ],
    });
    assert.equal(await level(mouse, branch), 103000);
    await reconciled();
  });

  test('voiding a sale puts the goods back and reverses the cost', async () => {
    const { id } = await c.post('/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-04-10', post: true, warehouseId: branch,
      lines: [{ itemId: mouse, quantity: 10000, unitPrice: 30000 }],
    });
    assert.equal(await level(mouse, branch), 93000);
    await c.post(`/api/documents/${id}/void`, {});
    assert.equal(await level(mouse, branch), 103000);
    await reconciled();
  });

  test('a purchase whose goods were already sold cannot be voided', async () => {
    const { id } = await c.post('/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-05-01', post: true, warehouseId: branch,
      lines: [{ itemId: mouse, quantity: 1000, unitPrice: 20000 }],
    });
    await c.post('/api/inventory/operations', {
      kind: 'adjustment', date: '2026-05-02', warehouseId: branch, post: true,
      lines: [{ itemId: mouse, qty: -104000 }],
    });
    const res = await c.raw('POST', `/api/documents/${id}/void`, {});
    assert.equal(res.body.error.code, 'stock.insufficient');
    await reconciled();
  });

  test('voiding a stock document restores stock and keeps the books in line', async () => {
    const ops = await c.get('/api/inventory/operations?kind=transfer');
    await c.post(`/api/inventory/operations/${ops.rows[0].id}/void`, {});
    assert.equal(await level(laptop, branch), 0);
    await reconciled();
  });

  test('stock tracking cannot be switched off once an item has moved', async () => {
    const item = (await c.get('/api/items')).find((x: any) => x.id === laptop);
    const res = await c.raw('PUT', `/api/items/${laptop}`, {
      sku: item.sku, nameEn: item.name_en, nameAr: item.name_ar, kind: 'product', trackStock: false,
    });
    assert.equal(res.body.error.code, 'item.stock_locked');
  });

  test('stock card has running balances that end at the current stock', async () => {
    const card = await c.get(`/api/inventory/items/${laptop}/card`);
    const now = await itemCard(laptop);
    assert.equal(card.closing.qty, now.qty);
    assert.equal(card.closing.value, now.value);
    assert.equal(card.rows.at(-1).balance_qty, now.qty);
  });

  test('stock list, reorder and movement reports', async () => {
    const stock = await c.get('/api/inventory/stock');
    const lap = stock.rows.find((r: any) => r.id === laptop);
    assert.ok(['low', 'ok'].includes(lap.status));
    const byBarcode = await c.get('/api/inventory/stock?q=6221234567890');
    assert.equal(byBarcode.rows.length, 1);
    const reorder = await c.get('/api/inventory/reports/reorder');
    for (const r of reorder) assert.ok(r.qty <= r.reorder_level && r.suggested > 0);
    const mv = await c.get('/api/inventory/reports/movement?from=2026-01-01&to=2026-12-31');
    for (const r of mv.rows) {
      const card = await itemCard(r.id);
      assert.equal(r.closing_qty, card.qty);
      assert.equal(r.closing_value, card.value);
    }
  });

  test('profitability: revenue minus the cost of what was sold', async () => {
    const p = await c.get('/api/inventory/reports/profitability?from=2026-01-01&to=2026-12-31');
    const lap = p.rows.find((r: any) => r.id === laptop);
    assert.equal(lap.qty, 3000); // 4 sold - 1 returned
    assert.equal(lap.revenue, 4_500_000);
    assert.equal(lap.cost, 3_300_000);
    assert.equal(lap.profit, 1_200_000);
  });

  test('the stock ledger itself is immutable', () => {
    assert.throws(() => c.app.kernel.db.run('UPDATE stock_moves SET qty = 1'), /immutable/);
    assert.throws(() => c.app.kernel.db.run('DELETE FROM stock_moves'), /immutable/);
    assert.throws(() => c.app.kernel.db.run('UPDATE stock_levels SET qty = -1'), /CHECK/);
  });
});
