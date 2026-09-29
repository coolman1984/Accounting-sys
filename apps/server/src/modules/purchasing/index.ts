import type { AppModule } from '../../kernel/modules.js';
import { conflict, forbidden } from '../../kernel/errors.js';
import { paging, parse } from '../../kernel/validate.js';
import type {} from '../../contracts/fx.js';
import type { OpenPoSupply, PurchaseSupplyService } from '../../contracts/purchasing.js';
import { migrations } from './schema.js';
import { createPurchasing, zPo } from './orders.js';
import { createRequisitions, requisitionRoutes, type RequisitionService } from './requisitions.js';
import { createLettersOfCredit, lcRoutes } from './lc.js';
import { reportRoutes } from './reports.js';
import { wireEco } from './eco.js';

export type { PurchaseOrder, PoLine, PurchasingService } from './orders.js';

/** Per installation (tests build several apps in one process). */
const requisitionsOf = new WeakMap<object, RequisitionService>();

export const purchasingModule: AppModule = {
  id: 'purchasing',
  // Inventory is optional: with it, goods receipts count as received; without it, bills do.
  dependsOn: ['documents', 'parties', 'catalog'],
  after: ['eco'],
  permissions: [
    'purchasing.orders.read',
    'purchasing.orders.write',
    'purchasing.orders.approve',
    'purchasing.requisitions.read',
    'purchasing.requisitions.write',
    'purchasing.lc.read',
    'purchasing.lc.write',
    'purchasing.reports.read',
  ],
  apps: [{ id: 'purchasing', order: 50, requires: ['ap'], permissions: ['purchasing'] }],
  roles: [
    {
      id: 'purchasing_officer',
      permissions: [
        'purchasing.orders.read', 'purchasing.orders.write', 'purchasing.requisitions.*', 'purchasing.reports.read', 'purchasing.lc.read',
        'ap.suppliers.read', 'ap.suppliers.write', 'catalog.items.read', 'inventory.stock.read', 'inventory.receipts.read',
      ],
    },
    { id: 'import_officer', permissions: ['purchasing.orders.read', 'purchasing.lc.*', 'purchasing.reports.read', 'ap.suppliers.read', 'ap.bills.read'] },
  ],
  sod: [
    ['purchasing.orders.write', 'purchasing.orders.approve'],
    ['purchasing.lc.write', 'purchasing.orders.approve'],
  ],
  health({ db }) {
    const over = db.get<{ n: number }>(
      'SELECT COUNT(*) n FROM purchase_order_lines WHERE received_base > base_quantity OR billed_base > base_quantity OR received_base < 0 OR billed_base < 0',
    )!.n;
    // A converted requisition always points at an order line that carries it.
    const orphan = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM purchase_requisitions q WHERE q.status IN ('converted', 'closed') AND q.po_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.po_id = q.po_id AND l.requisition_id = q.id)`,
    )!.n;
    // What the LCs say they hold as margin equals the margin still booked on them (per LC, from their own entries).
    const lc = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM letters_of_credit c WHERE c.margin_used_base > c.margin_base OR c.repaid_base > c.financed_base OR c.settled_amount > c.amount`,
    )!.n;
    return [
      { id: 'progress', ok: over === 0, details: { count: over } },
      { id: 'requisitions', ok: orphan === 0, details: { count: orphan } },
      { id: 'letters_of_credit', ok: lc === 0, details: { count: lc } },
    ];
  },
  migrations,

  setup(ctx) {
    const svc = createPurchasing(ctx);
    ctx.services.provide('purchasing', svc);
    // What open purchase orders still bring, per item and date (the sales module's availability-to-promise reads it).
    // A line's own expected date wins over the order's; an order without any date counts on its order date.
    const supply: PurchaseSupplyService = {
      openSupply: (itemId) =>
        ctx.db.all<OpenPoSupply>(
          `SELECT o.id AS poId, o.number AS poNumber, l.id AS lineId, l.item_id AS itemId, o.warehouse_id AS warehouseId,
                  COALESCE(l.expected_date, o.expected_date, o.date) AS date, l.base_quantity - l.received_base AS qty
           FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
           WHERE o.status = 'open' AND l.item_id IS NOT NULL AND l.base_quantity > l.received_base ${itemId ? 'AND l.item_id = ?' : ''}
           ORDER BY date, o.id, l.line_no`,
          itemId ? [itemId] : [],
        ),
    };
    ctx.services.provide('purchaseSupply', supply);
    const requisitions = createRequisitions(ctx, () => svc);
    requisitionsOf.set(ctx.services, requisitions);
    for (const [key, prefix] of [['purchase_order', 'PO-'], ['purchase_requisition', 'PR-'], ['letter_of_credit', 'LOC-']]) {
      ctx.db.run('INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES (?, ?, 1, 5)', [key, prefix]);
    }
    const { db, events, services } = ctx;
    wireEco(ctx, requisitions);
    const foreign = (code: string | null | undefined) => (code && services.has('fx') && services.get('fx').isForeign(code) ? code : null);

    // Goods receipts that reference order lines move the "received" counter.
    const onReceipt = (receiptId: number, sign: 1 | -1) => {
      const r = db.get<{ supplier_id: number; number: string; currency: string | null }>('SELECT supplier_id, number, currency FROM goods_receipts WHERE id = ?', [receiptId])!;
      for (const l of db.all<{ po_line_id: number; item_id: number; base_quantity: number; line_no: number }>(
        'SELECT po_line_id, item_id, base_quantity, line_no FROM goods_receipt_lines WHERE receipt_id = ? AND po_line_id IS NOT NULL',
        [receiptId],
      )) {
        svc.track(l.po_line_id, 'received_base', sign * l.base_quantity, { supplierId: r.supplier_id, itemId: l.item_id, label: `Line ${l.line_no}`, currency: foreign(r.currency) });
      }
    };
    events.on('stock.receipt.posted', (e) => onReceipt(e.receiptId, 1));
    events.on('stock.receipt.voided', (e) => onReceipt(e.receiptId, -1));

    // Supplier invoices that reference order lines move "billed" (and "received" when no receipt was made).
    const onBill = (documentId: number, kind: string, sign: 1 | -1) => {
      if (kind !== 'purchase_bill') return;
      const doc = services.get('documents').get(documentId);
      for (const l of db.all<{ ext: string | null; item_id: number | null; base_quantity: number; line_no: number }>(
        'SELECT ext, item_id, base_quantity, line_no FROM document_lines WHERE document_id = ?',
        [documentId],
      )) {
        const ext = l.ext ? JSON.parse(l.ext) : null;
        if (!ext?.poLineId) continue;
        const c = { supplierId: doc.party_id, itemId: l.item_id, label: `Line ${l.line_no}`, currency: foreign(doc.currency) };
        svc.track(Number(ext.poLineId), 'billed_base', sign * l.base_quantity, c);
        if (!ext.receiptLineId) svc.track(Number(ext.poLineId), 'received_base', sign * l.base_quantity, c);
      }
    };
    events.on('document.posted', (e) => onBill(e.documentId, e.kind, 1));
    events.on('document.voided', (e) => onBill(e.documentId, e.kind, -1));
  },

  routes(r, ctx) {
    const { db, services } = ctx;
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
                (SELECT COALESCE(SUM(billed_base), 0) * 1.0 / NULLIF(SUM(base_quantity), 0) FROM purchase_order_lines l WHERE l.po_id = o.id) AS billed_ratio,
                (SELECT MIN(COALESCE(l.expected_date, o.expected_date)) FROM purchase_order_lines l WHERE l.po_id = o.id AND l.received_base < l.base_quantity) AS next_expected
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
        `SELECT l.*, i.sku, i.name_en, i.name_ar, i.unit AS base_unit, i.tracking, u.name_en AS unit_name_en, u.name_ar AS unit_name_ar, t.code AS tax_code,
                q.number AS requisition_number, q.source AS requisition_source
         FROM purchase_order_lines l LEFT JOIN items i ON i.id = l.item_id LEFT JOIN item_units u ON u.id = l.unit_id LEFT JOIN taxes t ON t.id = l.tax_id
         LEFT JOIN purchase_requisitions q ON q.id = l.requisition_id
         WHERE l.po_id = ? ORDER BY l.line_no`,
        [o.id],
      );
      const receipts = services.has('inventory') ? db.all('SELECT id, number, date, status, currency, exchange_rate FROM goods_receipts WHERE po_id = ? ORDER BY id', [o.id]) : [];
      const bills = db.all(
        `SELECT DISTINCT d.id, d.number, d.date, d.status FROM documents d JOIN document_lines l ON l.document_id = d.id
         WHERE d.kind = 'purchase_bill' AND l.ext IS NOT NULL
           AND CAST(json_extract(l.ext, '$.poLineId') AS INTEGER) IN (SELECT id FROM purchase_order_lines WHERE po_id = ?) ORDER BY d.id`,
        [o.id],
      );
      const lcs = db.all('SELECT id, number, lc_number, status, currency, amount, settled_amount FROM letters_of_credit WHERE po_id = ? ORDER BY id', [o.id]);
      return {
        ...o,
        supplier: services.get('parties').get(o.supplier_id),
        lines: lines.map((l) => ({ ...l, to_receive: Math.max(0, l.base_quantity - l.received_base), to_bill: Math.max(0, l.base_quantity - l.billed_base) })),
        receipts,
        bills,
        letters_of_credit: lcs,
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
    r.delete('/purchase-orders/:id', 'purchasing.orders.write', ({ params, user }) => (po.remove(Number(params.id), user.id), { ok: true }));

    requisitionRoutes(r, ctx, requisitionsOf.get(services)!);
    lcRoutes(r, ctx, createLettersOfCredit(ctx));
    reportRoutes(r, ctx);
  },
};
