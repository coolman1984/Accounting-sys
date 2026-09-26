import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { conflict, fail, forbidden } from '../../kernel/errors.js';
import { addDays, nowIso, today } from '../../kernel/dates.js';
import { divRound } from '../../kernel/money.js';
import { paging, parse, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import { migrations, STOCK_DOC_KINDS, STOCK_SEQ } from './schema.js';
import { createInventory, type InventoryService } from './service.js';

declare module '../../kernel/services.js' {
  interface ServiceMap {
    inventory: InventoryService;
  }
}

const zWarehouse = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  address: zOptText(300),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
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
  permissions: ['inventory.read', 'inventory.write', 'inventory.post'],

  setup(ctx) {
    const inv = createInventory(ctx);
    ctx.services.provide('inventory', inv);
    // Stock follows sales & purchase documents automatically, inside their transaction.
    ctx.events.on('document.posted', (e) => inv.onDocumentPosted(e.documentId, e.userId));
    ctx.events.on('document.voided', (e) => inv.onDocumentVoided(e.documentId, e.date, e.userId));
    // Idempotent: also covers companies created before this module existed.
    for (const [key, prefix] of Object.values(STOCK_SEQ)) {
      ctx.db.run('INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES (?, ?, 1, 5)', [key, prefix]);
    }
  },

  routes(r, { db, services }) {
    const inv = services.get('inventory');
    const audit = services.get('audit');

    // ------------------------------------------------------------ warehouses
    r.get('/inventory/warehouses', 'inventory.read', () =>
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
        return wid;
      });
    };

    r.post('/inventory/warehouses', 'inventory.write', ({ body, user }) => ({ id: saveWarehouse(null, parse(zWarehouse, body), user.id) }));
    r.put('/inventory/warehouses/:id', 'inventory.write', ({ params, body, user }) => {
      inv.warehouse(Number(params.id));
      return { id: saveWarehouse(Number(params.id), parse(zWarehouse, body), user.id) };
    });

    // ---------------------------------------------------------- stock on hand

    /** Quantities by item for one warehouse (or all), used for availability hints while typing documents. */
    r.get('/inventory/levels', 'inventory.read', ({ query }) => {
      const rows = query.warehouseId
        ? db.all<{ item_id: number; qty: number }>('SELECT item_id, qty FROM stock_levels WHERE warehouse_id = ?', [Number(query.warehouseId)])
        : db.all<{ item_id: number; qty: number }>('SELECT item_id, SUM(qty) qty FROM stock_levels GROUP BY item_id');
      return Object.fromEntries(rows.map((x) => [x.item_id, x.qty]));
    });

    r.get('/inventory/stock', 'inventory.read', ({ query }) => {
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

    r.get('/inventory/summary', 'inventory.read', () => {
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
    r.get('/inventory/items/:id', 'inventory.read', ({ params }) => {
      const item = services.get('catalog').item(Number(params.id));
      const p = inv.pool(item.id);
      const levels = db.all<{ warehouse_id: number; code: string; name_en: string; name_ar: string; qty: number }>(
        `SELECT w.id AS warehouse_id, w.code, w.name_en, w.name_ar, COALESCE(l.qty, 0) qty
         FROM warehouses w LEFT JOIN stock_levels l ON l.warehouse_id = w.id AND l.item_id = ?
         WHERE w.is_active = 1 OR l.qty > 0 ORDER BY w.is_default DESC, w.code`,
        [item.id],
      );
      return {
        item,
        qty: p.qty,
        value: p.value,
        avg_cost: unitCost(p.qty, p.value),
        levels: levels.map((l) => ({ ...l, value: valueOf(l.qty, p.qty, p.value) })),
      };
    });

    /** The stock card (كارت الصنف): every movement with running balances. */
    r.get('/inventory/items/:id/card', 'inventory.read', ({ params, query }) => {
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
        `SELECT m.*, w.code AS warehouse_code, je.number AS journal_number,
                COALESCE(d.number, sd.number) AS source_number,
                COALESCE(pa.name, NULL) AS party_name
         FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN journal_entries je ON je.id = m.journal_entry_id
         LEFT JOIN documents d ON m.source_type IN ('sales_invoice', 'sales_credit', 'purchase_bill', 'purchase_credit') AND d.id = m.source_id
         LEFT JOIN parties pa ON pa.id = d.party_id
         LEFT JOIN stock_docs sd ON m.source_type IN ('adjustment', 'opening', 'count', 'transfer') AND sd.id = m.source_id
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
    r.get('/inventory/by-source', 'inventory.read', ({ query }) => {
      const q = parse(z.object({ type: z.string(), id: zId }), query);
      return db.all(
        `SELECT m.id, m.date, m.qty, m.value, m.is_reversal, m.item_id, i.sku, i.name_en, i.name_ar, w.code AS warehouse_code,
                m.journal_entry_id, je.number AS journal_number
         FROM stock_moves m JOIN items i ON i.id = m.item_id JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN journal_entries je ON je.id = m.journal_entry_id
         WHERE m.source_type = ? AND m.source_id = ? ORDER BY m.id`,
        [q.type, q.id],
      );
    });

    // ------------------------------------------------------ stock documents
    r.get('/inventory/operations', 'inventory.read', ({ query }) => {
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

    r.get('/inventory/operations/:id', 'inventory.read', ({ params }) => {
      const d = inv.stockDoc(Number(params.id));
      const lines = db.all(
        `SELECT l.*, i.sku, i.name_en, i.name_ar, i.unit,
                (SELECT COALESCE(SUM(m.value), 0) FROM stock_moves m
                 WHERE m.source_type = :kind AND m.source_id = :id AND m.source_line_id = l.id AND m.is_reversal = 0
                   AND (:kind <> 'transfer' OR m.qty > 0)) AS value
         FROM stock_doc_lines l JOIN items i ON i.id = l.item_id WHERE l.doc_id = :id ORDER BY l.line_no`,
        { id: d.id, kind: d.kind },
      );
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

    r.post('/inventory/operations', 'inventory.write', ({ body, user }) => {
      const input = parse(zStockDoc, body);
      if (input.post && !user.permissions.has('inventory.post')) forbidden('inventory.post');
      const id = db.tx(() => {
        const id = inv.createDoc(input, user.id);
        if (input.post) inv.postDoc(id, user.id);
        return id;
      });
      return { id };
    });

    r.put('/inventory/operations/:id', 'inventory.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zStockDoc, body);
      if (input.post && !user.permissions.has('inventory.post')) forbidden('inventory.post');
      db.tx(() => {
        inv.updateDoc(id, input, user.id);
        if (input.post) inv.postDoc(id, user.id);
      });
      return { id };
    });

    r.post('/inventory/operations/:id/post', 'inventory.post', ({ params, user }) => {
      inv.postDoc(Number(params.id), user.id);
      return { ok: true };
    });

    r.post('/inventory/operations/:id/void', 'inventory.post', ({ params, body, user }) => {
      const input = parse(z.object({ date: zDate.nullish() }), body ?? {});
      inv.voidDoc(Number(params.id), input, user.id);
      return { ok: true };
    });

    r.delete('/inventory/operations/:id', 'inventory.write', ({ params, user }) => {
      inv.removeDoc(Number(params.id), user.id);
      return { ok: true };
    });

    // --------------------------------------------------------------- reports

    /** Stock valuation at a date, reconciled with the inventory accounts in the ledger. */
    r.get('/inventory/reports/valuation', 'inventory.read', ({ query }) => {
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
    r.get('/inventory/reports/movement', 'inventory.read', ({ query }) => {
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
                -SUM(CASE WHEN m.date BETWEEN :from AND :to AND m.qty < 0 THEN m.value ELSE 0 END) AS out_value
         FROM stock_moves m JOIN items i ON i.id = m.item_id
         WHERE m.date <= :to ${wh} GROUP BY i.id ORDER BY i.sku`,
        prm,
      );
      const out = rows
        .map((x) => ({
          ...x,
          closing_qty: x.opening_qty + x.in_qty - x.out_qty,
          closing_value: q.warehouseId ? null : x.opening_value + x.in_value - x.out_value,
          opening_value: q.warehouseId ? null : x.opening_value,
        }))
        .filter((x) => x.opening_qty || x.in_qty || x.out_qty);
      return { ...q, rows: out };
    });

    /** What to buy: items at or below their reorder level. */
    r.get('/inventory/reports/reorder', 'inventory.read', ({ query }) => {
      const wh = query.warehouseId ? Number(query.warehouseId) : null;
      const rows = db.all<any>(
        `SELECT i.id, i.sku, i.name_en, i.name_ar, i.unit, i.reorder_level, i.reorder_qty, i.purchase_price,
                ${wh ? 'COALESCE((SELECT qty FROM stock_levels l WHERE l.item_id = i.id AND l.warehouse_id = :wh), 0)' : 'COALESCE(v.qty, 0)'} AS qty,
                (SELECT -COALESCE(SUM(m.qty), 0) FROM stock_moves m WHERE m.item_id = i.id AND m.source_type = 'sales_invoice'
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
    r.get('/inventory/reports/profitability', 'inventory.read', ({ query }) => {
      const y = today().slice(0, 4);
      const q = parse(z.object({ from: zDate.default(`${y}-01-01`), to: zDate.default(`${y}-12-31`) }), query);
      const sales = db.all<{ item_id: number; qty: number; revenue: number }>(
        `SELECT l.item_id,
                SUM(CASE WHEN d.kind = 'sales_invoice' THEN l.quantity ELSE -l.quantity END) qty,
                SUM(CASE WHEN d.kind = 'sales_invoice' THEN l.net ELSE -l.net END) revenue
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
  },
};
