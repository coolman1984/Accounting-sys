import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { conflict, fail, forbidden } from '../../kernel/errors.js';
import { addDays, nowIso, today } from '../../kernel/dates.js';
import { divRound } from '../../kernel/money.js';
import { paging, parse, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import { migrations, STOCK_DOC_KINDS, STOCK_SEQ } from './schema.js';
import { createInventory, type InventoryService } from './service.js';
import { publishInventory, warehouseChanged } from './eco.js';

const zWarehouse = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  address: zOptText(300),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

const zLots = z
  .array(z.object({ lotNo: z.string().trim().min(1).max(64), expiry: zDate.nullish().transform((v) => v ?? null), qty: z.number().int().positive() }))
  .max(5000)
  .nullish()
  .transform((v) => v ?? null);

const zReceipt = z.object({
  supplierId: zId,
  poId: zOptId.transform((v) => v ?? null),
  date: zDate,
  warehouseId: zId,
  reference: zOptText(100),
  notes: zOptText(2000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish().transform((v) => v ?? null),
  exchangeRate: z.number().int().positive().nullish().transform((v) => v ?? null),
  lines: z
    .array(
      z.object({
        itemId: zId,
        description: zOptText(300),
        unitId: zOptId.transform((v) => v ?? null),
        quantity: z.number().int().positive(),
        unitCost: z.number().int().min(0),
        poLineId: zOptId.transform((v) => v ?? null),
        lots: zLots,
      }),
    )
    .min(1)
    .max(1000),
  post: z.boolean().default(false),
});

const zLanded = z.object({
  date: zDate,
  counterAccountId: zId,
  amount: z.number().int().positive(),
  method: z.enum(['value', 'qty']).default('value'),
  reference: zOptText(100),
  memo: zOptText(1000),
  targets: z.array(z.object({ sourceType: z.enum(['purchase_bill', 'goods_receipt']), sourceId: zId })).min(1).max(100),
  post: z.boolean().default(false),
});

const zStockDoc = z.object({
  kind: z.enum(STOCK_DOC_KINDS),
  date: zDate,
  warehouseId: zId,
  toWarehouseId: zOptId.transform((v) => v ?? null),
  counterAccountId: zOptId.transform((v) => v ?? null),
  reference: zOptText(100),
  memo: zOptText(1000),
  lines: z
    .array(
      z.object({
        itemId: zId,
        qty: z.number().int(),
        unitCost: z.number().int().min(0).nullish().transform((v) => v ?? null),
        note: zOptText(300),
        unitId: zOptId.transform((v) => v ?? null),
        lots: zLots,
      }),
    )
    .min(1)
    .max(2000),
  post: z.boolean().default(false),
});

/** Average unit cost (minor units per whole unit) of a qty/value pair. */
const unitCost = (qty: number, value: number) => (qty > 0 ? Number(divRound(BigInt(value) * 1000n, BigInt(qty))) : 0);
const valueOf = (qty: number, poolQty: number, poolValue: number) =>
  poolQty > 0 ? Number(divRound(BigInt(poolValue) * BigInt(qty), BigInt(poolQty))) : 0;

export const inventoryModule: AppModule = {
  id: 'inventory',
  dependsOn: ['ledger', 'catalog', 'documents'],
  migrations,
  permissions: [
    'inventory.stock.read',
    'inventory.operations.write',
    'inventory.operations.post',
    'inventory.receipts.read',
    'inventory.receipts.write',
    'inventory.receipts.post',
    'inventory.landed.write',
    'inventory.landed.post',
    'inventory.warehouses.manage',
  ],
  apps: [{ id: 'inventory', order: 40, permissions: ['inventory', 'catalog'] }],
  roles: [
    {
      id: 'storekeeper',
      permissions: ['inventory.stock.read', 'inventory.operations.write', 'inventory.receipts.read', 'inventory.receipts.write', 'catalog.items.read', 'ap.suppliers.read'],
    },
    { id: 'inventory_controller', permissions: ['inventory.*', 'catalog.items.*', 'ap.suppliers.read'] },
  ],
  sod: [['inventory.operations.write', 'inventory.operations.post']],
  health({ db, services }) {
    const stock = db.get<{ v: number }>('SELECT COALESCE(SUM(value), 0) v FROM stock_values')!.v;
    const gl = db.get<{ b: number }>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM ledger l JOIN accounts a ON a.id = l.account_id WHERE a.subtype = 'inventory'`,
    )!.b;
    const levels = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM stock_values v
       WHERE v.qty <> (SELECT COALESCE(SUM(qty), 0) FROM stock_levels l WHERE l.item_id = v.item_id)
          OR v.value <> (SELECT COALESCE(SUM(value), 0) FROM stock_moves m WHERE m.item_id = v.item_id)`,
    )!.n;
    const lots = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM stock_levels l JOIN items i ON i.id = l.item_id
       WHERE i.tracking <> 'none' AND l.qty <> (SELECT COALESCE(SUM(ll.qty), 0) FROM lot_levels ll JOIN stock_lots s ON s.id = ll.lot_id
                                                WHERE s.item_id = l.item_id AND ll.warehouse_id = l.warehouse_id)`,
    )!.n;
    const grniId = services.get('ledger').defaultAccounts().grni;
    const grniOpen = db.get<{ v: number }>(
      `SELECT COALESCE(SUM(l.value - l.billed_value), 0) v FROM goods_receipt_lines l JOIN goods_receipts r ON r.id = l.receipt_id
       WHERE r.status = 'posted'`,
    )!.v;
    const grniGl = grniId ? db.get<{ b: number }>('SELECT COALESCE(SUM(credit - debit), 0) b FROM ledger WHERE account_id = ?', [grniId])!.b : 0;
    const negative = db.get<{ n: number }>('SELECT COUNT(*) n FROM stock_levels WHERE qty < 0')!.n;
    return [
      { id: 'valuation', ok: stock === gl, details: { stock, ledger: gl, difference: gl - stock } },
      { id: 'levels', ok: levels === 0, details: { count: levels } },
      { id: 'lots', ok: lots === 0, details: { count: lots } },
      { id: 'grni', ok: grniOpen === grniGl, details: { open: grniOpen, ledger: grniGl, difference: grniGl - grniOpen } },
      { id: 'negative', ok: negative === 0, details: { count: negative } },
    ];
  },

  after: ['eco'],
  setup(ctx) {
    const inv = createInventory(ctx);
    ctx.services.provide('inventory', inv);
    publishInventory(ctx);
    // Stock follows sales & purchase documents automatically, inside their transaction.
    // With the Inventory app off, new documents no longer move stock. Voids always run:
    // they only undo moves that exist, so stock stays right whatever was switched since.
    ctx.events.on('document.posted', (e) => ctx.apps.isEnabled('inventory') && inv.onDocumentPosted(e.documentId, e.userId));
    ctx.events.on('document.voided', (e) => inv.onDocumentVoided(e.documentId, e.date, e.userId));
    // Idempotent: also covers companies created before this module existed.
    for (const [key, prefix] of [...Object.values(STOCK_SEQ), ['goods_receipt', 'GRN-'], ['landed_cost', 'LC-']]) {
      ctx.db.run('INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES (?, ?, 1, 5)', [key, prefix]);
    }
  },

  routes(r, { db, services }) {
    // The registry exposes the public contract; the module itself uses its full service.
    const inv = services.get('inventory') as unknown as InventoryService;
    const audit = services.get('audit');

    // ------------------------------------------------------------ warehouses
    r.get('/inventory/warehouses', 'inventory.stock.read', () =>
      db.all(
        `SELECT w.*,
                (SELECT COUNT(*) FROM stock_levels l WHERE l.warehouse_id = w.id AND l.qty > 0) AS items,
                (SELECT COALESCE(SUM(CASE WHEN v.qty > 0 THEN l.qty * 1.0 * v.value / v.qty END), 0)
                 FROM stock_levels l JOIN stock_values v ON v.item_id = l.item_id WHERE l.warehouse_id = w.id) AS value
         FROM warehouses w ORDER BY w.is_default DESC, w.code`,
      ).map((w: any) => ({ ...w, value: Math.round(w.value) })),
    );

    const saveWarehouse = (id: number | null, input: z.infer<typeof zWarehouse>, userId: number) => {
      const dup = db.get<{ id: number }>('SELECT id FROM warehouses WHERE code = ?', [input.code]);
      if (dup && dup.id !== id) conflict('warehouse.duplicate_code', 'Warehouse code already exists');
      if (id != null && !input.isActive) {
        if (db.get('SELECT 1 FROM stock_levels WHERE warehouse_id = ? AND qty > 0', [id])) {
          fail('warehouse.has_stock', 'Move the stock out before deactivating this warehouse');
        }
      }
      return db.tx(() => {
        const row = { code: input.code, name_en: input.nameEn, name_ar: input.nameAr, address: input.address, is_active: input.isActive };
        const wid = id ?? db.insert('warehouses', { ...row, is_default: 0, created_at: nowIso() });
        if (id != null) db.update('warehouses', id, row);
        if (input.isDefault && input.isActive) {
          db.run('UPDATE warehouses SET is_default = 0');
          db.run('UPDATE warehouses SET is_default = 1 WHERE id = ?', [wid]);
        }
        if (!db.get('SELECT 1 FROM warehouses WHERE is_default = 1 AND is_active = 1')) {
          fail('warehouse.default_required', 'One active warehouse must be the default');
        }
        audit.log({ userId, action: id == null ? 'create' : 'update', entity: 'warehouse', entityId: wid, summary: input.code });
        // A new default changes the old default too; unchanged snapshots publish nothing.
        warehouseChanged(services, db, input.isDefault ? undefined : wid);
        return wid;
      });
    };

    r.post('/inventory/warehouses', 'inventory.warehouses.manage', ({ body, user }) => ({ id: saveWarehouse(null, parse(zWarehouse, body), user.id) }));
    r.put('/inventory/warehouses/:id', 'inventory.warehouses.manage', ({ params, body, user }) => {
      inv.warehouse(Number(params.id));
      return { id: saveWarehouse(Number(params.id), parse(zWarehouse, body), user.id) };
    });

    // ---------------------------------------------------------- stock on hand

    /** Quantities by item for one warehouse (or all), used for availability hints while typing documents. */
    r.get('/inventory/levels', 'inventory.stock.read', ({ query }) => {
      const rows = query.warehouseId
        ? db.all<{ item_id: number; qty: number }>('SELECT item_id, qty FROM stock_levels WHERE warehouse_id = ?', [Number(query.warehouseId)])
        : db.all<{ item_id: number; qty: number }>('SELECT item_id, SUM(qty) qty FROM stock_levels GROUP BY item_id');
      return Object.fromEntries(rows.map((x) => [x.item_id, x.qty]));
    });

    r.get('/inventory/stock', 'inventory.stock.read', ({ query }) => {
      const wh = query.warehouseId ? Number(query.warehouseId) : null;
      const where = ["i.kind = 'product'", 'i.track_stock = 1'];
      const p: Record<string, string | number> = {};
      if (query.categoryId) (where.push('i.category_id = :cat'), (p.cat = Number(query.categoryId)));
      if (query.active !== '0') where.push('i.is_active = 1');
      if (query.q) {
        where.push('(i.sku LIKE :q OR i.name_en LIKE :q OR i.name_ar LIKE :q OR i.barcode = :exact)');
        p.q = `%${query.q}%`;
        p.exact = query.q;
      }
      if (wh) p.wh = wh;
      const rows = db.all<any>(
        `SELECT i.id, i.sku, i.barcode, i.name_en, i.name_ar, i.unit, i.reorder_level, i.reorder_qty, i.sale_price,
                c.name_en AS category_name_en, c.name_ar AS category_name_ar,
                COALESCE(v.qty, 0) AS total_qty, COALESCE(v.value, 0) AS total_value,
                ${wh ? 'COALESCE((SELECT qty FROM stock_levels l WHERE l.item_id = i.id AND l.warehouse_id = :wh), 0)' : 'COALESCE(v.qty, 0)'} AS qty,
                (SELECT MAX(date) FROM stock_moves m WHERE m.item_id = i.id ${wh ? 'AND m.warehouse_id = :wh' : ''}) AS last_move,
                (SELECT MAX(date) FROM stock_moves m WHERE m.item_id = i.id AND m.qty < 0 AND m.is_reversal = 0
                   AND m.source_type = 'sales_invoice' ${wh ? 'AND m.warehouse_id = :wh' : ''}) AS last_sale
         FROM items i LEFT JOIN stock_values v ON v.item_id = i.id LEFT JOIN item_categories c ON c.id = i.category_id
         WHERE ${where.join(' AND ')} ORDER BY i.sku`,
        p,
      );
      const out = rows.map((x) => {
        const value = wh ? valueOf(x.qty, x.total_qty, x.total_value) : x.total_value;
        const status = x.qty <= 0 ? 'out' : x.reorder_level > 0 && x.qty <= x.reorder_level ? 'low' : 'ok';
        return { ...x, value, avg_cost: unitCost(x.total_qty, x.total_value), status };
      });
      const filtered = query.status ? out.filter((x) => (query.status === 'in' ? x.qty > 0 : x.status === query.status)) : out;
      return {
        rows: filtered,
        totals: { qty: filtered.reduce((s, x) => s + x.qty, 0), value: filtered.reduce((s, x) => s + x.value, 0) },
      };
    });

    r.get('/inventory/summary', 'inventory.stock.read', () => {
      const items = db.all<{ qty: number; value: number; reorder_level: number }>(
        `SELECT COALESCE(v.qty, 0) qty, COALESCE(v.value, 0) value, i.reorder_level FROM items i LEFT JOIN stock_values v ON v.item_id = i.id
         WHERE i.kind = 'product' AND i.track_stock = 1 AND i.is_active = 1`,
      );
      const top = db.all(
        `SELECT i.id, i.sku, i.name_en, i.name_ar, v.qty, v.value FROM stock_values v JOIN items i ON i.id = v.item_id
         WHERE v.value > 0 ORDER BY v.value DESC LIMIT 5`,
      );
      const low = db.all(
        `SELECT i.id, i.sku, i.name_en, i.name_ar, COALESCE(v.qty, 0) qty, i.reorder_level FROM items i LEFT JOIN stock_values v ON v.item_id = i.id
         WHERE i.kind = 'product' AND i.track_stock = 1 AND i.is_active = 1 AND i.reorder_level > 0 AND COALESCE(v.qty, 0) <= i.reorder_level
         ORDER BY COALESCE(v.qty, 0) * 1.0 / i.reorder_level LIMIT 8`,
      );
      return {
        value: items.reduce((s, x) => s + x.value, 0),
        items: items.length,
        inStock: items.filter((x) => x.qty > 0).length,
        low: items.filter((x) => x.qty > 0 && x.reorder_level > 0 && x.qty <= x.reorder_level).length,
        out: items.filter((x) => x.qty <= 0).length,
        warehouses: db.get<{ n: number }>('SELECT COUNT(*) n FROM warehouses WHERE is_active = 1')!.n,
        top,
        lowItems: low,
      };
    });

    // ------------------------------------------------------------- item card
    r.get('/inventory/items/:id', 'inventory.stock.read', ({ params }) => {
      const item = services.get('catalog').item(Number(params.id));
      const p = inv.pool(item.id);
      const levels = db.all<{ warehouse_id: number; code: string; name_en: string; name_ar: string; qty: number }>(
        `SELECT w.id AS warehouse_id, w.code, w.name_en, w.name_ar, COALESCE(l.qty, 0) qty
         FROM warehouses w LEFT JOIN stock_levels l ON l.warehouse_id = w.id AND l.item_id = ?
         WHERE w.is_active = 1 OR l.qty > 0 ORDER BY w.is_default DESC, w.code`,
        [item.id],
      );
      const lots = db.all(
        `SELECT l.id, l.lot_no, l.expiry_date, w.code AS warehouse_code, ll.warehouse_id, ll.qty
         FROM lot_levels ll JOIN stock_lots l ON l.id = ll.lot_id JOIN warehouses w ON w.id = ll.warehouse_id
         WHERE l.item_id = ? AND ll.qty > 0 ORDER BY (l.expiry_date IS NULL), l.expiry_date, l.lot_no`,
        [item.id],
      );
      return {
        item,
        units: services.get('catalog').units(item.id),
        lots,
        qty: p.qty,
        value: p.value,
        avg_cost: unitCost(p.qty, p.value),
        levels: levels.map((l) => ({ ...l, value: valueOf(l.qty, p.qty, p.value) })),
      };
    });

    /** The stock card (كارت الصنف): every movement with running balances. */
    r.get('/inventory/items/:id/card', 'inventory.stock.read', ({ params, query }) => {
      const itemId = Number(params.id);
      services.get('catalog').item(itemId);
      const q = parse(z.object({ from: zDate.nullish(), to: zDate.nullish(), warehouseId: zOptId }), query);
      const whSql = q.warehouseId ? 'AND warehouse_id = :wh' : '';
      const prm: Record<string, string | number> = { item: itemId };
      if (q.warehouseId) prm.wh = q.warehouseId;
      const opening = q.from
        ? db.get<{ qty: number; value: number }>(
            `SELECT COALESCE(SUM(qty), 0) qty, COALESCE(SUM(value), 0) value FROM stock_moves WHERE item_id = :item ${whSql} AND date < :from`,
            { ...prm, from: q.from },
          )!
        : { qty: 0, value: 0 };
      const where = [`m.item_id = :item`];
      if (q.warehouseId) where.push('m.warehouse_id = :wh');
      if (q.from) (where.push('m.date >= :from'), (prm.from = q.from));
      if (q.to) (where.push('m.date <= :to'), (prm.to = q.to));
      const moves = db.all<any>(
        `SELECT m.*, w.code AS warehouse_code, je.number AS journal_number, lot.lot_no, lot.expiry_date,
                COALESCE(d.number, sd.number, gr.number, lc.number) AS source_number,
                COALESCE(pa.name, sup.name) AS party_name
         FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN journal_entries je ON je.id = m.journal_entry_id
         LEFT JOIN documents d ON m.source_type IN ('sales_invoice', 'sales_credit', 'purchase_bill', 'purchase_credit') AND d.id = m.source_id
         LEFT JOIN parties pa ON pa.id = d.party_id
         LEFT JOIN goods_receipts gr2 ON m.source_type = 'goods_receipt' AND gr2.id = m.source_id
         LEFT JOIN parties sup ON sup.id = gr2.supplier_id
         LEFT JOIN stock_docs sd ON m.source_type IN ('adjustment', 'opening', 'count', 'transfer') AND sd.id = m.source_id
         LEFT JOIN goods_receipts gr ON m.source_type = 'goods_receipt' AND gr.id = m.source_id
         LEFT JOIN landed_costs lc ON m.source_type = 'landed_cost' AND lc.id = m.source_id
         LEFT JOIN stock_lots lot ON lot.id = m.lot_id
         WHERE ${where.join(' AND ')} ORDER BY m.date, m.id`,
        prm,
      );
      let qty = opening.qty;
      let value = opening.value;
      const rows = moves.map((m) => {
        qty += m.qty;
        value += m.value;
        return { ...m, balance_qty: qty, balance_value: value, unit_cost: unitCost(Math.abs(m.qty), Math.abs(m.value)) };
      });
      return {
        opening,
        rows,
        closing: { qty, value },
        totals: {
          in_qty: rows.filter((x) => x.qty > 0).reduce((s, x) => s + x.qty, 0),
          in_value: rows.filter((x) => x.qty > 0).reduce((s, x) => s + x.value, 0),
          out_qty: -rows.filter((x) => x.qty < 0).reduce((s, x) => s + x.qty, 0),
          out_value: -rows.filter((x) => x.qty < 0).reduce((s, x) => s + x.value, 0),
        },
      };
    });

    /** Stock movements & cost entries produced by a sales/purchase document or stock document. */
    r.get('/inventory/by-source', 'inventory.stock.read', ({ query }) => {
      const q = parse(z.object({ type: z.string(), id: zId }), query);
      return db.all(
        `SELECT m.id, m.date, m.qty, m.value, m.is_reversal, m.item_id, i.sku, i.name_en, i.name_ar, w.code AS warehouse_code,
                m.journal_entry_id, je.number AS journal_number, lot.lot_no, lot.expiry_date, m.source_type
         FROM stock_moves m JOIN items i ON i.id = m.item_id JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN journal_entries je ON je.id = m.journal_entry_id
         LEFT JOIN stock_lots lot ON lot.id = m.lot_id
         WHERE (m.source_type = ? AND m.source_id = ?)
            OR (? IN ('purchase_bill', 'sales_invoice', 'sales_credit', 'purchase_credit') AND m.source_type = 'grn_variance' AND m.source_id = ?)
         ORDER BY m.id`,
        [q.type, q.id, q.type, q.id],
      );
    });

    // ------------------------------------------------------ stock documents
    r.get('/inventory/operations', 'inventory.stock.read', ({ query }) => {
      const { limit, offset } = paging(query);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.kind) (where.push('d.kind = :kind'), (p.kind = query.kind));
      if (query.status) (where.push('d.status = :status'), (p.status = query.status));
      if (query.warehouseId) (where.push('(d.warehouse_id = :wh OR d.to_warehouse_id = :wh)'), (p.wh = Number(query.warehouseId)));
      if (query.q) (where.push('(d.number LIKE :q OR d.reference LIKE :q OR d.memo LIKE :q)'), (p.q = `%${query.q}%`));
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.all(
        `SELECT d.*, w.code AS warehouse_code, w.name_en AS warehouse_name_en, w.name_ar AS warehouse_name_ar,
                t.code AS to_warehouse_code, t.name_en AS to_warehouse_name_en, t.name_ar AS to_warehouse_name_ar,
                (SELECT COUNT(*) FROM stock_doc_lines l WHERE l.doc_id = d.id) AS line_count,
                (SELECT COALESCE(SUM(m.value), 0) FROM stock_moves m WHERE m.source_type = d.kind AND m.source_id = d.id AND m.is_reversal = 0) AS value
         FROM stock_docs d JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN warehouses t ON t.id = d.to_warehouse_id
         ${w} ORDER BY d.date DESC, d.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit, offset },
      );
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM stock_docs d ${w}`, p)!.n;
      return { rows, total };
    });

    r.get('/inventory/operations/:id', 'inventory.stock.read', ({ params }) => {
      const d = inv.stockDoc(Number(params.id));
      const lines = db.all(
        `SELECT l.*, i.sku, i.name_en, i.name_ar, i.unit, i.tracking, u.name_en AS unit_name_en, u.name_ar AS unit_name_ar,
                (SELECT COALESCE(SUM(m.value), 0) FROM stock_moves m
                 WHERE m.source_type = :kind AND m.source_id = :id AND m.source_line_id = l.id AND m.is_reversal = 0
                   AND (:kind <> 'transfer' OR m.qty > 0)) AS value
         FROM stock_doc_lines l JOIN items i ON i.id = l.item_id LEFT JOIN item_units u ON u.id = l.unit_id
         WHERE l.doc_id = :id ORDER BY l.line_no`,
        { id: d.id, kind: d.kind },
      ).map((l: any) => ({ ...l, lots: l.lots ? JSON.parse(l.lots) : null }));
      const je = (id: number | null) => (id ? db.get<{ number: string }>('SELECT number FROM journal_entries WHERE id = ?', [id])?.number : null);
      return {
        ...d,
        warehouse: inv.warehouse(d.warehouse_id),
        to_warehouse: d.to_warehouse_id ? inv.warehouse(d.to_warehouse_id) : null,
        counter_account: d.counter_account_id ? services.get('ledger').account(d.counter_account_id) : null,
        lines,
        journal_number: je(d.journal_entry_id),
        void_journal_number: je(d.void_entry_id),
      };
    });

    r.post('/inventory/operations', 'inventory.operations.write', ({ body, user }) => {
      const input = parse(zStockDoc, body);
      if (input.post && !user.permissions.has('inventory.operations.post')) forbidden('inventory.operations.post');
      const id = db.tx(() => {
        const id = inv.createDoc(input, user.id);
        if (input.post) inv.postDoc(id, user.id);
        return id;
      });
      return { id };
    });

    r.put('/inventory/operations/:id', 'inventory.operations.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zStockDoc, body);
      if (input.post && !user.permissions.has('inventory.operations.post')) forbidden('inventory.operations.post');
      db.tx(() => {
        inv.updateDoc(id, input, user.id);
        if (input.post) inv.postDoc(id, user.id);
      });
      return { id };
    });

    r.post('/inventory/operations/:id/post', 'inventory.operations.post', ({ params, user }) => {
      inv.postDoc(Number(params.id), user.id);
      return { ok: true };
    });

    r.post('/inventory/operations/:id/void', 'inventory.operations.post', ({ params, body, user }) => {
      const input = parse(z.object({ date: zDate.nullish() }), body ?? {});
      inv.voidDoc(Number(params.id), input, user.id);
      return { ok: true };
    });

    r.delete('/inventory/operations/:id', 'inventory.operations.write', ({ params, user }) => {
      inv.removeDoc(Number(params.id), user.id);
      return { ok: true };
    });

    // --------------------------------------------------------------- reports

    /** Stock valuation at a date, reconciled with the inventory accounts in the ledger. */
    r.get('/inventory/reports/valuation', 'inventory.stock.read', ({ query }) => {
      const q = parse(z.object({ asOf: zDate.default(today()), warehouseId: zOptId }), query);
      const rows = db.all<any>(
        `SELECT i.id, i.sku, i.name_en, i.name_ar, i.unit, c.name_en AS category_name_en, c.name_ar AS category_name_ar,
                SUM(m.qty) AS qty, SUM(m.value) AS value
         FROM stock_moves m JOIN items i ON i.id = m.item_id LEFT JOIN item_categories c ON c.id = i.category_id
         WHERE m.date <= :asOf GROUP BY i.id HAVING SUM(m.qty) <> 0 OR SUM(m.value) <> 0 ORDER BY i.sku`,
        { asOf: q.asOf },
      );
      // Warehouse filter: that warehouse's quantity valued at the item's average.
      let out = rows.map((x) => ({ ...x, avg_cost: unitCost(x.qty, x.value) }));
      if (q.warehouseId) {
        const whQty = new Map(
          db
            .all<{ item_id: number; qty: number }>(
              'SELECT item_id, SUM(qty) qty FROM stock_moves WHERE date <= ? AND warehouse_id = ? GROUP BY item_id',
              [q.asOf, q.warehouseId],
            )
            .map((x) => [x.item_id, x.qty]),
        );
        out = out
          .map((x) => {
            const qty = whQty.get(x.id) ?? 0;
            return { ...x, qty, value: valueOf(qty, x.qty, x.value) };
          })
          .filter((x) => x.qty !== 0);
      }
      const stockValue = out.reduce((s, x) => s + x.value, 0);
      const gl = db.get<{ b: number }>(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE a.subtype = 'inventory' AND l.date <= ?`,
        [q.asOf],
      )!.b;
      return { ...q, rows: out, total: stockValue, ledger: q.warehouseId ? null : gl, difference: q.warehouseId ? null : gl - stockValue };
    });

    /** Opening, in, out and closing for each item over a period. */
    r.get('/inventory/reports/movement', 'inventory.stock.read', ({ query }) => {
      const y = today().slice(0, 4);
      const q = parse(z.object({ from: zDate.default(`${y}-01-01`), to: zDate.default(`${y}-12-31`), warehouseId: zOptId }), query);
      const wh = q.warehouseId ? 'AND m.warehouse_id = :wh' : '';
      const prm: Record<string, string | number> = { from: q.from, to: q.to };
      if (q.warehouseId) prm.wh = q.warehouseId;
      const rows = db.all<any>(
        `SELECT i.id, i.sku, i.name_en, i.name_ar, i.unit,
                SUM(CASE WHEN m.date < :from THEN m.qty ELSE 0 END) AS opening_qty,
                SUM(CASE WHEN m.date < :from THEN m.value ELSE 0 END) AS opening_value,
                SUM(CASE WHEN m.date BETWEEN :from AND :to AND m.qty > 0 THEN m.qty ELSE 0 END) AS in_qty,
                SUM(CASE WHEN m.date BETWEEN :from AND :to AND m.qty > 0 THEN m.value ELSE 0 END) AS in_value,
                -SUM(CASE WHEN m.date BETWEEN :from AND :to AND m.qty < 0 THEN m.qty ELSE 0 END) AS out_qty,
                -SUM(CASE WHEN m.date BETWEEN :from AND :to AND m.qty < 0 THEN m.value ELSE 0 END) AS out_value,
                SUM(CASE WHEN m.date BETWEEN :from AND :to AND m.qty = 0 THEN m.value ELSE 0 END) AS adj_value
         FROM stock_moves m JOIN items i ON i.id = m.item_id
         WHERE m.date <= :to ${wh} GROUP BY i.id ORDER BY i.sku`,
        prm,
      );
      const out = rows
        .map((x) => ({
          ...x,
          closing_qty: x.opening_qty + x.in_qty - x.out_qty,
          closing_value: q.warehouseId ? null : x.opening_value + x.in_value - x.out_value + x.adj_value,
          opening_value: q.warehouseId ? null : x.opening_value,
        }))
        .filter((x) => x.opening_qty || x.in_qty || x.out_qty || x.adj_value);
      return { ...q, rows: out };
    });

    /** What to buy: items at or below their reorder level. */
    r.get('/inventory/reports/reorder', 'inventory.stock.read', ({ query }) => {
      const wh = query.warehouseId ? Number(query.warehouseId) : null;
      const rows = db.all<any>(
        `SELECT i.id, i.sku, i.name_en, i.name_ar, i.unit, i.reorder_level, i.reorder_qty, i.purchase_price,
                ${wh ? 'COALESCE((SELECT qty FROM stock_levels l WHERE l.item_id = i.id AND l.warehouse_id = :wh), 0)' : 'COALESCE(v.qty, 0)'} AS qty,
                (SELECT -COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.item_id = i.id AND m.source_type IN ('sales_invoice', 'sales_delivery')
                   AND m.date >= :since ${wh ? 'AND m.warehouse_id = :wh' : ''}) AS sold_90d
         FROM items i LEFT JOIN stock_values v ON v.item_id = i.id
         WHERE i.kind = 'product' AND i.track_stock = 1 AND i.is_active = 1 AND i.reorder_level > 0 ORDER BY i.sku`,
        wh ? { wh, since: addDays(today(), -90) } : { since: addDays(today(), -90) },
      );
      return rows
        .filter((x) => x.qty <= x.reorder_level)
        .map((x) => {
          const suggested = Math.max(x.reorder_qty, x.reorder_level - x.qty, 0);
          return { ...x, suggested, est_cost: Number(divRound(BigInt(suggested) * BigInt(x.purchase_price), 1000n)) };
        });
    });

    /** Gross profit per item: revenue from sales documents vs the cost of the goods that left. */
    r.get('/inventory/reports/profitability', 'inventory.stock.read', ({ query }) => {
      const y = today().slice(0, 4);
      const q = parse(z.object({ from: zDate.default(`${y}-01-01`), to: zDate.default(`${y}-12-31`) }), query);
      const sales = db.all<{ item_id: number; qty: number; revenue: number }>(
        `SELECT l.item_id,
                SUM(CASE WHEN d.kind = 'sales_invoice' THEN l.base_quantity ELSE -l.base_quantity END) qty,
                SUM(CASE WHEN d.kind = 'sales_invoice' THEN l.base_net ELSE -l.base_net END) revenue
         FROM document_lines l JOIN documents d ON d.id = l.document_id
         WHERE d.kind IN ('sales_invoice', 'sales_credit') AND d.status = 'posted' AND l.item_id IS NOT NULL
           AND d.date BETWEEN ? AND ? GROUP BY l.item_id`,
        [q.from, q.to],
      );
      const cost = new Map(
        db
          .all<{ item_id: number; cost: number }>(
            `SELECT m.item_id, -SUM(m.value) cost FROM stock_moves m JOIN documents d ON d.id = m.source_id AND d.kind = m.source_type
             WHERE m.source_type IN ('sales_invoice', 'sales_credit') AND d.status = 'posted' AND m.is_reversal = 0
               AND d.date BETWEEN ? AND ? GROUP BY m.item_id`,
            [q.from, q.to],
          )
          .map((x) => [x.item_id, x.cost]),
      );
      // Invoices made from deliveries: their goods left with the delivery — take its cost for the invoiced share.
      for (const x of db.all<{ item_id: number; cost: number }>(
        `SELECT x.item_id, SUM(x.base_quantity * 1.0 * (SELECT -SUM(m.value) FROM stock_moves m WHERE m.source_type = 'sales_delivery' AND m.source_line_id = x.dl)
                              / NULLIF((SELECT -SUM(m.qty) FROM stock_moves m WHERE m.source_type = 'sales_delivery' AND m.source_line_id = x.dl), 0)) cost
         FROM (SELECT l.item_id, l.base_quantity, CAST(json_extract(l.ext, '$.deliveryLineId') AS INTEGER) dl
               FROM document_lines l JOIN documents d ON d.id = l.document_id
               WHERE d.kind = 'sales_invoice' AND d.status = 'posted' AND l.ext IS NOT NULL AND json_extract(l.ext, '$.deliveryLineId') IS NOT NULL
                 AND d.date BETWEEN ? AND ?) x
         GROUP BY x.item_id`,
        [q.from, q.to],
      )) {
        cost.set(x.item_id, (cost.get(x.item_id) ?? 0) + Math.round(x.cost ?? 0));
      }
      const items = new Map(
        db.all<{ id: number; sku: string; name_en: string; name_ar: string; kind: string }>('SELECT id, sku, name_en, name_ar, kind FROM items').map((x) => [x.id, x]),
      );
      const rows = sales
        .map((s) => {
          const c = cost.get(s.item_id) ?? 0;
          const profit = s.revenue - c;
          return {
            ...items.get(s.item_id)!,
            qty: s.qty,
            revenue: s.revenue,
            cost: c,
            profit,
            margin_bp: s.revenue ? Math.round((profit * 10000) / s.revenue) : 0,
          };
        })
        .sort((a, b) => b.profit - a.profit);
      const totals = rows.reduce((t, x) => ({ revenue: t.revenue + x.revenue, cost: t.cost + x.cost, profit: t.profit + x.profit }), { revenue: 0, cost: 0, profit: 0 });
      return { ...q, rows, totals };
    });

    // ------------------------------------------------------ lots & serials
    /** Lots in stock (optionally for one item / warehouse) — used by lot pickers. */
    r.get('/inventory/lots', 'inventory.stock.read', ({ query }) => {
      const where = ['ll.qty > 0'];
      const p: Record<string, string | number> = {};
      if (query.itemId) (where.push('l.item_id = :item'), (p.item = Number(query.itemId)));
      if (query.warehouseId) (where.push('ll.warehouse_id = :wh'), (p.wh = Number(query.warehouseId)));
      return db.all(
        `SELECT l.id, l.item_id, l.lot_no, l.expiry_date, ll.warehouse_id, w.code AS warehouse_code, ll.qty
         FROM lot_levels ll JOIN stock_lots l ON l.id = ll.lot_id JOIN warehouses w ON w.id = ll.warehouse_id
         WHERE ${where.join(' AND ')} ORDER BY (l.expiry_date IS NULL), l.expiry_date, l.id LIMIT 20000`,
        p,
      );
    });

    /** Near-expiry and expired stock, valued at average cost. */
    r.get('/inventory/reports/expiry', 'inventory.stock.read', ({ query }) => {
      const days = Math.min(Math.max(Number(query.days ?? 90) || 90, 0), 3650);
      const t = today();
      const until = addDays(t, days);
      const p: Record<string, string | number> = { until };
      let wh = '';
      if (query.warehouseId) (wh = 'AND ll.warehouse_id = :wh'), (p.wh = Number(query.warehouseId));
      const rows = db.all<any>(
        `SELECT l.id, l.lot_no, l.expiry_date, i.id AS item_id, i.sku, i.name_en, i.name_ar, i.unit, w.code AS warehouse_code, ll.qty,
                COALESCE(v.qty, 0) AS pool_qty, COALESCE(v.value, 0) AS pool_value
         FROM lot_levels ll JOIN stock_lots l ON l.id = ll.lot_id JOIN items i ON i.id = l.item_id
         JOIN warehouses w ON w.id = ll.warehouse_id LEFT JOIN stock_values v ON v.item_id = i.id
         WHERE ll.qty > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date <= :until ${wh}
         ORDER BY l.expiry_date, i.sku`,
        p,
      );
      const out = rows.map((x) => ({
        ...x,
        value: valueOf(x.qty, x.pool_qty, x.pool_value),
        days_left: Math.round((Date.parse(x.expiry_date) - Date.parse(t)) / 86_400_000),
        status: x.expiry_date < t ? 'expired' : 'expiring',
      }));
      return {
        days,
        rows: out,
        expiredValue: out.filter((x) => x.status === 'expired').reduce((s, x) => s + x.value, 0),
        expiringValue: out.filter((x) => x.status === 'expiring').reduce((s, x) => s + x.value, 0),
      };
    });

    /** Trace a lot or serial number from the supplier to the customer (recalls, warranty). */
    r.get('/inventory/trace', 'inventory.stock.read', ({ query }) => {
      const code = String(query.q ?? '').trim();
      if (!code) return { lots: [] };
      const lots = db.all<any>(
        `SELECT l.id, l.lot_no, l.expiry_date, i.id AS item_id, i.sku, i.name_en, i.name_ar, i.tracking
         FROM stock_lots l JOIN items i ON i.id = l.item_id WHERE l.lot_no LIKE ? ORDER BY l.lot_no LIMIT 50`,
        [`%${code}%`],
      );
      return {
        lots: lots.map((l) => ({
          ...l,
          on_hand: db.all(
            `SELECT w.code AS warehouse_code, ll.qty FROM lot_levels ll JOIN warehouses w ON w.id = ll.warehouse_id WHERE ll.lot_id = ? AND ll.qty > 0`,
            [l.id],
          ),
          moves: db.all(
            `SELECT m.id, m.date, m.qty, m.source_type, m.source_id, m.is_reversal, w.code AS warehouse_code,
                    COALESCE(d.number, sd.number, gr.number) AS source_number, COALESCE(pa.name, sup.name) AS party_name
             FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id
             LEFT JOIN documents d ON m.source_type IN ('sales_invoice', 'sales_credit', 'purchase_bill', 'purchase_credit') AND d.id = m.source_id
             LEFT JOIN parties pa ON pa.id = d.party_id
             LEFT JOIN stock_docs sd ON m.source_type IN ('adjustment', 'opening', 'count', 'transfer') AND sd.id = m.source_id
             LEFT JOIN goods_receipts gr ON m.source_type = 'goods_receipt' AND gr.id = m.source_id
             LEFT JOIN parties sup ON sup.id = gr.supplier_id
             WHERE m.lot_id = ? ORDER BY m.date, m.id`,
            [l.id],
          ),
        })),
      };
    });

    // ------------------------------------------------------- goods receipts
    const receiptView = (id: number) => {
      const rc = inv.receipt(id);
      const lines = db.all<any>(
        `SELECT l.*, i.sku, i.name_en, i.name_ar, i.unit AS base_unit, i.tracking, u.name_en AS unit_name_en, u.name_ar AS unit_name_ar
         FROM goods_receipt_lines l JOIN items i ON i.id = l.item_id LEFT JOIN item_units u ON u.id = l.unit_id
         WHERE l.receipt_id = ? ORDER BY l.line_no`,
        [id],
      );
      const je = (x: number | null) => (x ? db.get<{ number: string }>('SELECT number FROM journal_entries WHERE id = ?', [x])?.number : null);
      return {
        ...rc,
        supplier: services.get('parties').get(rc.supplier_id),
        warehouse: inv.warehouse(rc.warehouse_id),
        lines: lines.map((l) => ({ ...l, lots: l.lots ? JSON.parse(l.lots) : null, remaining_base: l.base_quantity - l.billed_base })),
        journal_number: je(rc.journal_entry_id),
        void_journal_number: je(rc.void_entry_id),
        grni_account_id: rc.status === 'posted' ? inv.engine.grniAccount() : null,
      };
    };

    r.get('/inventory/receipts', 'inventory.receipts.read', ({ query }) => {
      const { limit, offset } = paging(query);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.status) (where.push('r.status = :status'), (p.status = query.status));
      if (query.supplierId) (where.push('r.supplier_id = :sup'), (p.sup = Number(query.supplierId)));
      if (query.unbilled === '1') where.push("r.status = 'posted' AND EXISTS (SELECT 1 FROM goods_receipt_lines l WHERE l.receipt_id = r.id AND l.billed_base < l.base_quantity)");
      if (query.q) (where.push('(r.number LIKE :q OR r.reference LIKE :q OR pa.name LIKE :q)'), (p.q = `%${query.q}%`));
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.all(
        `SELECT r.*, pa.name AS supplier_name, w.code AS warehouse_code,
                (SELECT COALESCE(SUM(value), 0) FROM goods_receipt_lines l WHERE l.receipt_id = r.id) AS value,
                (SELECT COALESCE(SUM(value - billed_value), 0) FROM goods_receipt_lines l WHERE l.receipt_id = r.id) AS unbilled_value
         FROM goods_receipts r JOIN parties pa ON pa.id = r.supplier_id JOIN warehouses w ON w.id = r.warehouse_id
         ${w} ORDER BY r.date DESC, r.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit, offset },
      );
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM goods_receipts r JOIN parties pa ON pa.id = r.supplier_id ${w}`, p)!.n;
      return { rows, total };
    });

    r.get('/inventory/receipts/:id', 'inventory.receipts.read', ({ params }) => receiptView(Number(params.id)));

    r.post('/inventory/receipts', 'inventory.receipts.write', ({ body, user }) => {
      const input = parse(zReceipt, body);
      if (input.post && !user.permissions.has('inventory.receipts.post')) forbidden('inventory.receipts.post');
      const id = db.tx(() => {
        const id = inv.createReceipt(input, user.id);
        if (input.post) inv.postReceipt(id, user.id);
        return id;
      });
      return { id };
    });

    r.put('/inventory/receipts/:id', 'inventory.receipts.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zReceipt, body);
      if (input.post && !user.permissions.has('inventory.receipts.post')) forbidden('inventory.receipts.post');
      db.tx(() => {
        inv.updateReceipt(id, input, user.id);
        if (input.post) inv.postReceipt(id, user.id);
      });
      return { id };
    });

    r.post('/inventory/receipts/:id/post', 'inventory.receipts.post', ({ params, user }) => {
      inv.postReceipt(Number(params.id), user.id);
      return { ok: true };
    });

    r.post('/inventory/receipts/:id/void', 'inventory.receipts.post', ({ params, body, user }) => {
      inv.voidReceipt(Number(params.id), parse(z.object({ date: zDate.nullish() }), body ?? {}), user.id);
      return { ok: true };
    });

    r.delete('/inventory/receipts/:id', 'inventory.receipts.write', ({ params, user }) => {
      inv.removeReceipt(Number(params.id), user.id);
      return { ok: true };
    });

    /** Received but not yet invoiced — reconciled with the GRNI account. */
    r.get('/inventory/reports/grni', 'inventory.receipts.read', ({ query }) => {
      const asOf = String(query.asOf ?? today());
      const rows = db.all<any>(
        `SELECT l.id, r.id AS receipt_id, r.number, r.date, pa.name AS supplier_name, i.sku, i.name_en, i.name_ar,
                l.base_quantity, l.billed_base, l.value, l.billed_value
         FROM goods_receipt_lines l JOIN goods_receipts r ON r.id = l.receipt_id JOIN parties pa ON pa.id = r.supplier_id
         JOIN items i ON i.id = l.item_id
         WHERE r.status = 'posted' AND l.billed_base < l.base_quantity ORDER BY r.date, r.id, l.line_no`,
      );
      const open = rows.reduce((s, x) => s + (x.value - x.billed_value), 0);
      const grni = services.get('ledger').defaultAccounts().grni;
      const ledgerBalance = grni
        ? db.get<{ b: number }>('SELECT COALESCE(SUM(credit - debit), 0) b FROM ledger WHERE account_id = ? AND date <= ?', [grni, asOf])!.b
        : 0;
      return { rows, open, ledger: ledgerBalance };
    });

    // --------------------------------------------------------- landed costs
    r.get('/inventory/landed-costs', 'inventory.stock.read', ({ query }) => {
      const { limit, offset } = paging(query);
      const rows = db.all(
        `SELECT lc.*, a.code AS counter_code, a.name_en AS counter_name_en, a.name_ar AS counter_name_ar,
                (SELECT COUNT(*) FROM landed_cost_targets t WHERE t.landed_cost_id = lc.id) AS targets
         FROM landed_costs lc JOIN accounts a ON a.id = lc.counter_account_id
         ORDER BY lc.date DESC, lc.id DESC LIMIT ? OFFSET ?`,
        [limit, offset],
      );
      return { rows, total: db.get<{ n: number }>('SELECT COUNT(*) n FROM landed_costs')!.n };
    });

    /** Purchases that can carry landed costs (recent posted bills and receipts with stock items). */
    r.get('/inventory/landed-costs/candidates', 'inventory.stock.read', ({ query }) => {
      const since = String(query.since ?? addDays(today(), -365));
      return db.all(
        `SELECT 'purchase_bill' AS source_type, d.id AS source_id, d.number, d.date, pa.name AS supplier_name,
                (SELECT COALESCE(SUM(m.value), 0) FROM stock_moves m WHERE m.source_type = 'purchase_bill' AND m.source_id = d.id AND m.qty > 0 AND m.is_reversal = 0) AS value
         FROM documents d JOIN parties pa ON pa.id = d.party_id
         WHERE d.kind = 'purchase_bill' AND d.status = 'posted' AND d.date >= :since
           AND EXISTS (SELECT 1 FROM stock_moves m WHERE m.source_type = 'purchase_bill' AND m.source_id = d.id)
         UNION ALL
         SELECT 'goods_receipt', r.id, r.number, r.date, pa.name,
                (SELECT COALESCE(SUM(value), 0) FROM goods_receipt_lines l WHERE l.receipt_id = r.id)
         FROM goods_receipts r JOIN parties pa ON pa.id = r.supplier_id
         WHERE r.status = 'posted' AND r.date >= :since
         ORDER BY 4 DESC LIMIT 300`,
        { since },
      );
    });

    r.get('/inventory/landed-costs/:id', 'inventory.stock.read', ({ params }) => {
      const lc = inv.landedCost(Number(params.id));
      const targets = db.all(
        `SELECT t.source_type, t.source_id, COALESCE(d.number, r.number) AS number, COALESCE(d.date, r.date) AS date, COALESCE(p1.name, p2.name) AS supplier_name
         FROM landed_cost_targets t
         LEFT JOIN documents d ON t.source_type = 'purchase_bill' AND d.id = t.source_id LEFT JOIN parties p1 ON p1.id = d.party_id
         LEFT JOIN goods_receipts r ON t.source_type = 'goods_receipt' AND r.id = t.source_id LEFT JOIN parties p2 ON p2.id = r.supplier_id
         WHERE t.landed_cost_id = ?`,
        [lc.id],
      );
      const allocations =
        lc.status === 'draft'
          ? inv.landedCostBasis(lc.id).map((b) => ({ item_id: b.item_id, received_qty: b.qty, received_value: b.value }))
          : db.all('SELECT * FROM landed_cost_allocations WHERE landed_cost_id = ?', [lc.id]);
      const items = new Map(db.all<any>('SELECT id, sku, name_en, name_ar FROM items').map((x) => [x.id, x]));
      const je = (x: number | null) => (x ? db.get<{ number: string }>('SELECT number FROM journal_entries WHERE id = ?', [x])?.number : null);
      return {
        ...lc,
        counter_account: services.get('ledger').account(lc.counter_account_id),
        targets,
        allocations: (allocations as any[]).map((a) => ({ ...a, ...items.get(a.item_id) })),
        journal_number: je(lc.journal_entry_id),
        void_journal_number: je(lc.void_entry_id),
      };
    });

    r.post('/inventory/landed-costs', 'inventory.landed.write', ({ body, user }) => {
      const input = parse(zLanded, body);
      if (input.post && !user.permissions.has('inventory.landed.post')) forbidden('inventory.landed.post');
      const id = db.tx(() => {
        const id = inv.createLandedCost(input, user.id);
        if (input.post) inv.postLandedCost(id, user.id);
        return id;
      });
      return { id };
    });

    r.put('/inventory/landed-costs/:id', 'inventory.landed.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zLanded, body);
      if (input.post && !user.permissions.has('inventory.landed.post')) forbidden('inventory.landed.post');
      db.tx(() => {
        inv.updateLandedCost(id, input, user.id);
        if (input.post) inv.postLandedCost(id, user.id);
      });
      return { id };
    });

    r.post('/inventory/landed-costs/:id/post', 'inventory.landed.post', ({ params, user }) => {
      inv.postLandedCost(Number(params.id), user.id);
      return { ok: true };
    });

    r.post('/inventory/landed-costs/:id/void', 'inventory.landed.post', ({ params, body, user }) => {
      inv.voidLandedCost(Number(params.id), parse(z.object({ date: zDate.nullish() }), body ?? {}), user.id);
      return { ok: true };
    });

    r.delete('/inventory/landed-costs/:id', 'inventory.landed.write', ({ params, user }) => {
      inv.removeLandedCost(Number(params.id), user.id);
      return { ok: true };
    });
  },
};
