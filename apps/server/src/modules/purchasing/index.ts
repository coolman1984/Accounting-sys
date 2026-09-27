import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, forbidden, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { computeLine, divRound, sum } from '../../kernel/money.js';
import { paging, parse, zBp, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';

export interface PurchaseOrder {
  id: number;
  number: string | null;
  supplier_id: number;
  date: string;
  expected_date: string | null;
  warehouse_id: number | null;
  reference: string | null;
  notes: string | null;
  status: 'draft' | 'open' | 'closed' | 'cancelled';
  subtotal: number;
  tax_total: number;
  total: number;
}

export interface PoLine {
  id: number;
  po_id: number;
  line_no: number;
  item_id: number | null;
  description: string;
  unit_id: number | null;
  unit_factor: number;
  quantity: number;
  base_quantity: number;
  unit_price: number;
  discount_bp: number;
  tax_id: number | null;
  tax_rate_bp: number;
  net: number;
  tax: number;
  total: number;
  received_base: number;
  billed_base: number;
}

interface PoInput {
  supplierId: number;
  date: string;
  expectedDate: string | null;
  warehouseId: number | null;
  reference: string | null;
  notes: string | null;
  lines: { itemId: number | null; description: string | null; unitId: number | null; quantity: number; unitPrice: number; discountBp: number; taxId: number | null }[];
}

const zPo = z.object({
  supplierId: zId,
  date: zDate,
  expectedDate: zDate.nullish().transform((v) => v ?? null),
  warehouseId: zOptId.transform((v) => v ?? null),
  reference: zOptText(100),
  notes: zOptText(2000),
  lines: z
    .array(
      z.object({
        itemId: zOptId.transform((v) => v ?? null),
        description: zOptText(300),
        unitId: zOptId.transform((v) => v ?? null),
        quantity: z.number().int().positive(),
        unitPrice: z.number().int().min(0),
        discountBp: zBp.default(0),
        taxId: zOptId.transform((v) => v ?? null),
      }),
    )
    .min(1)
    .max(500),
  approve: z.boolean().default(false),
});

export type PurchasingService = ReturnType<typeof createPurchasing>;

declare module '../../kernel/services.js' {
  interface ServiceMap {
    purchasing: PurchasingService;
  }
}

/**
 * Purchase orders: what was ordered, what has arrived (goods receipts or
 * bills) and what has been invoiced. Orders never touch the books — they only
 * track the commitment.
 */
function createPurchasing({ db, services, apps }: ModuleContext) {
  const catalog = () => services.get('catalog');
  const audit = () => services.get('audit');

  const get = (id: number) => db.get<PurchaseOrder>('SELECT * FROM purchase_orders WHERE id = ?', [id]) ?? notFound('purchase_order', id);
  const lines = (id: number) => db.all<PoLine>('SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY line_no', [id]);
  const line = (id: number) => db.get<PoLine>('SELECT * FROM purchase_order_lines WHERE id = ?', [id]) ?? notFound('purchase_order_line', id);

  function write(id: number | null, input: PoInput, userId: number | null): number {
    const party = services.get('parties').get(input.supplierId);
    services.get('parties').assertKind(party, 'supplier');
    if (input.warehouseId && services.has('inventory')) services.get('inventory').warehouse(input.warehouseId);
    const computed = input.lines.map((l, i) => {
      const n = i + 1;
      const item = l.itemId ? catalog().item(l.itemId) : null;
      if (item && !item.is_active) fail('document.inactive_item', `Line ${n}: item ${item.sku} is inactive`, { line: n });
      const description = (l.description ?? '').trim() || item?.name_en || '';
      if (!description) fail('document.line_description', `Line ${n}: description is required`, { line: n });
      if (!item && l.unitId) fail('document.unit_without_item', `Line ${n}: a unit needs an item`, { line: n });
      const factor = item ? catalog().unitFactor(item, l.unitId) : 1000;
      let rate = 0;
      if (l.taxId && services.has('tax') && apps.isEnabled('tax')) {
        const tax = services.get('tax').get(l.taxId);
        if (tax.scope === 'sales') fail('document.tax_scope', `Line ${n}: tax ${tax.code} is not for purchases`, { line: n });
        rate = tax.rate_bp;
      }
      const c = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountBp: l.discountBp, rateBp: rate }, false);
      return {
        line_no: n,
        item_id: item?.id ?? null,
        description,
        unit_id: l.unitId,
        unit_factor: factor,
        quantity: l.quantity,
        base_quantity: Number(divRound(BigInt(l.quantity) * BigInt(factor), 1000n)),
        unit_price: l.unitPrice,
        discount_bp: l.discountBp,
        tax_id: l.taxId,
        tax_rate_bp: rate,
        net: c.net,
        tax: c.tax,
        total: c.total,
      };
    });
    const header = {
      supplier_id: input.supplierId,
      date: input.date,
      expected_date: input.expectedDate,
      warehouse_id: input.warehouseId,
      reference: input.reference,
      notes: input.notes,
      subtotal: sum(computed.map((l) => l.net)),
      tax_total: sum(computed.map((l) => l.tax)),
      total: sum(computed.map((l) => l.total)),
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let pid = id;
      if (pid == null) pid = db.insert('purchase_orders', { ...header, status: 'draft', created_by: userId, created_at: nowIso() });
      else {
        db.update('purchase_orders', pid, header);
        db.run('DELETE FROM purchase_order_lines WHERE po_id = ?', [pid]);
      }
      for (const l of computed) db.insert('purchase_order_lines', { ...l, po_id: pid });
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'purchase_order', entityId: pid });
      return pid;
    });
  }

  function approve(id: number, userId: number | null) {
    const po = get(id);
    if (po.status !== 'draft') conflict('po.not_draft', 'Only drafts can be approved');
    db.tx(() => {
      const number = services.get('sequences').next('purchase_order');
      db.run(`UPDATE purchase_orders SET status = 'open', number = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?`, [number, nowIso(), userId, nowIso(), id]);
      audit().log({ userId, action: 'approve', entity: 'purchase_order', entityId: id, summary: number });
    });
  }

  function setStatus(id: number, status: 'closed' | 'cancelled' | 'open', userId: number | null) {
    const po = get(id);
    const ls = lines(id);
    if (status === 'cancelled') {
      if (po.status === 'cancelled' || po.status === 'closed') conflict('po.cannot_cancel', 'This order cannot be cancelled');
      if (ls.some((l) => l.received_base > 0 || l.billed_base > 0)) conflict('po.has_activity', 'Goods were already received or invoiced — close the order instead');
    }
    if (status === 'closed' && po.status !== 'open') conflict('po.not_open', 'Only open orders can be closed');
    if (status === 'open' && po.status !== 'closed') conflict('po.not_closed', 'Only closed orders can be reopened');
    db.tx(() => {
      db.run('UPDATE purchase_orders SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?', [status, status === 'open' ? null : nowIso(), nowIso(), id]);
      audit().log({ userId, action: status === 'open' ? 'reopen' : status === 'closed' ? 'close' : 'cancel', entity: 'purchase_order', entityId: id, summary: po.number });
    });
  }

  /** Received / invoiced progress. `field` is received_base or billed_base; delta in base units. */
  function track(poLineId: number, field: 'received_base' | 'billed_base', delta: number, ctx: { supplierId: number; itemId: number | null; label: string }) {
    const l = line(poLineId);
    const po = get(l.po_id);
    if (po.supplier_id !== ctx.supplierId) fail('po.other_supplier', `${ctx.label}: that order belongs to another supplier`);
    // A line can only count against the order line for the same item.
    if ((l.item_id ?? null) !== (ctx.itemId ?? null)) fail('po.other_item', `${ctx.label}: the item differs from order ${po.number}`, { number: po.number });
    if (delta > 0 && po.status !== 'open') fail('po.not_open', `${ctx.label}: order ${po.number} is not open`, { number: po.number });
    const next = l[field] + delta;
    if (next > l.base_quantity) {
      fail('po.over_quantity', `${ctx.label}: more than ordered on ${po.number} (${(l.base_quantity - l[field]) / 1000} left)`, {
        number: po.number,
        left: (l.base_quantity - l[field]) / 1000,
      });
    }
    db.run(`UPDATE purchase_order_lines SET ${field} = ? WHERE id = ?`, [Math.max(0, next), l.id]);
    // Fully received and invoiced => closed automatically (and reopened if a document is voided).
    const all = lines(po.id);
    const done = all.every((x) => x.received_base >= x.base_quantity && x.billed_base >= x.base_quantity);
    if (done && po.status === 'open') db.run(`UPDATE purchase_orders SET status = 'closed', closed_at = ? WHERE id = ?`, [nowIso(), po.id]);
    if (!done && po.status === 'closed' && delta < 0) db.run(`UPDATE purchase_orders SET status = 'open', closed_at = NULL WHERE id = ?`, [po.id]);
  }

  return { get, lines, line, create: (i: PoInput, u: number | null) => write(null, i, u), update: write, approve, setStatus, track };
}

export const purchasingModule: AppModule = {
  id: 'purchasing',
  // Inventory is optional: with it, goods receipts count as received; without it, bills do.
  dependsOn: ['documents', 'parties', 'catalog'],
  permissions: ['purchasing.orders.read', 'purchasing.orders.write', 'purchasing.orders.approve'],
  apps: [{ id: 'purchasing', order: 50, requires: ['ap'], permissions: ['purchasing'] }],
  roles: [
    {
      id: 'purchasing_officer',
      permissions: ['purchasing.orders.read', 'purchasing.orders.write', 'ap.suppliers.read', 'ap.suppliers.write', 'catalog.items.read', 'inventory.stock.read', 'inventory.receipts.read'],
    },
  ],
  sod: [['purchasing.orders.write', 'purchasing.orders.approve']],
  health({ db }) {
    const over = db.get<{ n: number }>(
      'SELECT COUNT(*) n FROM purchase_order_lines WHERE received_base > base_quantity OR billed_base > base_quantity OR received_base < 0 OR billed_base < 0',
    )!.n;
    return [{ id: 'progress', ok: over === 0, details: { count: over } }];
  },
  migrations: [
    {
      id: '001_purchase_orders',
      up: `
        CREATE TABLE purchase_orders (
          id            INTEGER PRIMARY KEY,
          number        TEXT UNIQUE,
          supplier_id   INTEGER NOT NULL REFERENCES parties(id),
          date          TEXT NOT NULL,
          expected_date TEXT,
          warehouse_id  INTEGER REFERENCES warehouses(id),
          reference     TEXT,
          notes         TEXT,
          status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
          subtotal      INTEGER NOT NULL DEFAULT 0,
          tax_total     INTEGER NOT NULL DEFAULT 0,
          total         INTEGER NOT NULL DEFAULT 0,
          created_by    INTEGER REFERENCES users(id),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          approved_by   INTEGER REFERENCES users(id),
          approved_at   TEXT,
          closed_at     TEXT
        );
        CREATE INDEX purchase_orders_supplier ON purchase_orders(supplier_id, status);

        CREATE TABLE purchase_order_lines (
          id            INTEGER PRIMARY KEY,
          po_id         INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
          line_no       INTEGER NOT NULL,
          item_id       INTEGER REFERENCES items(id),
          description   TEXT NOT NULL,
          unit_id       INTEGER REFERENCES item_units(id),
          unit_factor   INTEGER NOT NULL DEFAULT 1000,
          quantity      INTEGER NOT NULL CHECK (quantity > 0),
          base_quantity INTEGER NOT NULL,
          unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),
          discount_bp   INTEGER NOT NULL DEFAULT 0,
          tax_id        INTEGER REFERENCES taxes(id),
          tax_rate_bp   INTEGER NOT NULL DEFAULT 0,
          net           INTEGER NOT NULL,
          tax           INTEGER NOT NULL,
          total         INTEGER NOT NULL,
          received_base INTEGER NOT NULL DEFAULT 0,   -- base units received (goods receipts, or bills without a receipt)
          billed_base   INTEGER NOT NULL DEFAULT 0    -- base units invoiced by the supplier
        );
        CREATE INDEX purchase_order_lines_po ON purchase_order_lines(po_id);

        CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders
        WHEN OLD.status <> 'draft'
        BEGIN SELECT RAISE(ABORT, 'purchasing: approved orders cannot be deleted'); END;
      `,
    },
  ],

  setup(ctx) {
    const svc = createPurchasing(ctx);
    ctx.services.provide('purchasing', svc);
    ctx.db.run("INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES ('purchase_order', 'PO-', 1, 5)");
    const { db, events } = ctx;

    // Goods receipts that reference order lines move the "received" counter.
    const onReceipt = (receiptId: number, sign: 1 | -1) => {
      const r = db.get<{ supplier_id: number; number: string }>('SELECT supplier_id, number FROM goods_receipts WHERE id = ?', [receiptId])!;
      for (const l of db.all<{ po_line_id: number; item_id: number; base_quantity: number; line_no: number }>(
        'SELECT po_line_id, item_id, base_quantity, line_no FROM goods_receipt_lines WHERE receipt_id = ? AND po_line_id IS NOT NULL',
        [receiptId],
      )) {
        svc.track(l.po_line_id, 'received_base', sign * l.base_quantity, { supplierId: r.supplier_id, itemId: l.item_id, label: `Line ${l.line_no}` });
      }
    };
    events.on('stock.receipt.posted', (e) => onReceipt(e.receiptId, 1));
    events.on('stock.receipt.voided', (e) => onReceipt(e.receiptId, -1));

    // Supplier invoices that reference order lines move "billed" (and "received" when no receipt was made).
    const onBill = (documentId: number, kind: string, sign: 1 | -1) => {
      if (kind !== 'purchase_bill') return;
      const doc = services().get('documents').get(documentId);
      for (const l of db.all<{ ext: string | null; item_id: number | null; base_quantity: number; line_no: number }>(
        'SELECT ext, item_id, base_quantity, line_no FROM document_lines WHERE document_id = ?',
        [documentId],
      )) {
        const ext = l.ext ? JSON.parse(l.ext) : null;
        if (!ext?.poLineId) continue;
        const c = { supplierId: doc.party_id, itemId: l.item_id, label: `Line ${l.line_no}` };
        svc.track(Number(ext.poLineId), 'billed_base', sign * l.base_quantity, c);
        if (!ext.receiptLineId) svc.track(Number(ext.poLineId), 'received_base', sign * l.base_quantity, c);
      }
    };
    const services = () => ctx.services;
    events.on('document.posted', (e) => onBill(e.documentId, e.kind, 1));
    events.on('document.voided', (e) => onBill(e.documentId, e.kind, -1));
  },

  routes(r, { db, services }) {
    const po = services.get('purchasing');

    r.get('/purchase-orders', 'purchasing.orders.read', ({ query }) => {
      const { limit, offset } = paging(query);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.status) (where.push('o.status = :status'), (p.status = query.status));
      if (query.supplierId) (where.push('o.supplier_id = :sup'), (p.sup = Number(query.supplierId)));
      if (query.q) (where.push('(o.number LIKE :q OR o.reference LIKE :q OR pa.name LIKE :q)'), (p.q = `%${query.q}%`));
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.all(
        `SELECT o.*, pa.name AS supplier_name,
                (SELECT COALESCE(SUM(received_base), 0) * 1.0 / NULLIF(SUM(base_quantity), 0) FROM purchase_order_lines l WHERE l.po_id = o.id) AS received_ratio,
                (SELECT COALESCE(SUM(billed_base), 0) * 1.0 / NULLIF(SUM(base_quantity), 0) FROM purchase_order_lines l WHERE l.po_id = o.id) AS billed_ratio
         FROM purchase_orders o JOIN parties pa ON pa.id = o.supplier_id
         ${w} ORDER BY o.date DESC, o.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit, offset },
      );
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM purchase_orders o JOIN parties pa ON pa.id = o.supplier_id ${w}`, p)!.n;
      return { rows, total };
    });

    r.get('/purchase-orders/:id', 'purchasing.orders.read', ({ params }) => {
      const o = po.get(Number(params.id));
      const lines = db.all<any>(
        `SELECT l.*, i.sku, i.name_en, i.name_ar, i.unit AS base_unit, i.tracking, u.name_en AS unit_name_en, u.name_ar AS unit_name_ar, t.code AS tax_code
         FROM purchase_order_lines l LEFT JOIN items i ON i.id = l.item_id LEFT JOIN item_units u ON u.id = l.unit_id LEFT JOIN taxes t ON t.id = l.tax_id
         WHERE l.po_id = ? ORDER BY l.line_no`,
        [o.id],
      );
      const receipts = services.has('inventory') ? db.all('SELECT id, number, date, status FROM goods_receipts WHERE po_id = ? ORDER BY id', [o.id]) : [];
      const bills = db.all(
        `SELECT DISTINCT d.id, d.number, d.date, d.status FROM documents d JOIN document_lines l ON l.document_id = d.id
         WHERE d.kind = 'purchase_bill' AND l.ext IS NOT NULL
           AND CAST(json_extract(l.ext, '$.poLineId') AS INTEGER) IN (SELECT id FROM purchase_order_lines WHERE po_id = ?) ORDER BY d.id`,
        [o.id],
      );
      return {
        ...o,
        supplier: services.get('parties').get(o.supplier_id),
        lines: lines.map((l) => ({ ...l, to_receive: Math.max(0, l.base_quantity - l.received_base), to_bill: Math.max(0, l.base_quantity - l.billed_base) })),
        receipts,
        bills,
      };
    });

    r.post('/purchase-orders', 'purchasing.orders.write', ({ body, user }) => {
      const input = parse(zPo, body);
      if (input.approve && !user.permissions.has('purchasing.orders.approve')) forbidden('purchasing.orders.approve');
      const id = db.tx(() => {
        const id = po.create(input, user.id);
        if (input.approve) po.approve(id, user.id);
        return id;
      });
      return { id };
    });

    r.put('/purchase-orders/:id', 'purchasing.orders.write', ({ params, body, user }) => {
      const id = Number(params.id);
      if (po.get(id).status !== 'draft') conflict('po.not_draft', 'Approved orders cannot be edited');
      const input = parse(zPo, body);
      if (input.approve && !user.permissions.has('purchasing.orders.approve')) forbidden('purchasing.orders.approve');
      db.tx(() => {
        po.update(id, input, user.id);
        if (input.approve) po.approve(id, user.id);
      });
      return { id };
    });

    r.post('/purchase-orders/:id/approve', 'purchasing.orders.approve', ({ params, user }) => (po.approve(Number(params.id), user.id), { ok: true }));
    r.post('/purchase-orders/:id/close', 'purchasing.orders.write', ({ params, user }) => (po.setStatus(Number(params.id), 'closed', user.id), { ok: true }));
    r.post('/purchase-orders/:id/reopen', 'purchasing.orders.write', ({ params, user }) => (po.setStatus(Number(params.id), 'open', user.id), { ok: true }));
    r.post('/purchase-orders/:id/cancel', 'purchasing.orders.write', ({ params, user }) => (po.setStatus(Number(params.id), 'cancelled', user.id), { ok: true }));
    r.delete('/purchase-orders/:id', 'purchasing.orders.write', ({ params, user }) => {
      const id = Number(params.id);
      if (po.get(id).status !== 'draft') conflict('po.not_draft', 'Only drafts can be deleted');
      db.tx(() => {
        db.run('DELETE FROM purchase_orders WHERE id = ?', [id]);
        services.get('audit').log({ userId: user.id, action: 'delete', entity: 'purchase_order', entityId: id });
      });
      return { ok: true };
    });
  },
};
