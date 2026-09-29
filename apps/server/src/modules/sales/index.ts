import { z } from 'zod';
import type { AppModule, SessionUser } from '../../kernel/modules.js';
import { forbidden } from '../../kernel/errors.js';
import { nowIso, today } from '../../kernel/dates.js';
import { paging, parse, zBp, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import type { SalesService } from '../../contracts/sales.js';
import type {} from '../../contracts/inventory.js';
import { migrations } from './schema.js';
import { createSales, type SalesInternal } from './service.js';
import { createReports } from './reports.js';
import { wireSalesEco } from './eco.js';

const zLots = z
  .array(z.object({ lotNo: z.string().trim().min(1).max(64), qty: z.number().int().positive() }))
  .max(5000)
  .nullish()
  .transform((v) => v ?? null);

const zOrder = z.object({
  customerId: zId,
  orderDate: zDate,
  customerReference: zOptText(100),
  shipTo: zOptText(500),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish().transform((v) => v ?? null),
  exchangeRate: z.number().int().positive().nullish().transform((v) => v ?? null),
  priority: z.number().int().min(1).max(9).default(5),
  warehouseId: zOptId.transform((v) => v ?? null),
  notes: zOptText(2000),
  lines: z
    .array(
      z.object({
        itemId: zId,
        description: zOptText(500),
        quantity: z.number().int().positive(),
        unitPrice: z.number().int().min(0).nullish(),
        discountBp: zBp.default(0),
        // Left out = the item's sales tax; null = no tax.
        taxId: z.number().int().positive().nullable().optional(),
        requestedDate: zDate.nullish(),
        warehouseId: zOptId.transform((v) => v ?? null),
      }),
    )
    .min(1)
    .max(500),
  confirm: z.boolean().default(false),
  override: z.boolean().default(false),
});

const zDelivery = z.object({
  soId: zId,
  date: zDate,
  shipTo: zOptText(500),
  reference: zOptText(100),
  notes: zOptText(2000),
  lines: z
    .array(z.object({ soLineId: zId, qty: z.number().int().positive(), warehouseId: zOptId.transform((v) => v ?? null), lots: zLots }))
    .max(500)
    .nullish()
    .transform((v) => v ?? null),
  post: z.boolean().default(false),
});

const zMonthRange = (q: Record<string, string | undefined>) => {
  const y = today().slice(0, 4);
  return parse(z.object({ from: zDate.default(`${y}-01-01`), to: zDate.default(`${y}-12-31`) }), q);
};

export const salesModule: AppModule = {
  id: 'sales',
  // Inventory, pricing, purchasing and fx are optional and reached through their services.
  dependsOn: ['documents', 'parties', 'catalog'],
  after: ['eco'],
  migrations,
  permissions: [
    'sales.orders.read',
    'sales.orders.write',
    'sales.orders.approve',
    'sales.orders.override',
    'sales.deliveries.read',
    'sales.deliveries.write',
    'sales.deliveries.post',
    'sales.reports.read',
    'sales.supply.write',
  ],
  apps: [{ id: 'sd', order: 15, requires: ['ar'], permissions: ['sales'] }],
  roles: [
    {
      id: 'sales_order_clerk',
      permissions: ['sales.orders.read', 'sales.orders.write', 'sales.orders.approve', 'sales.deliveries.read', 'sales.reports.read', 'ar.customers.read', 'catalog.items.read', 'pricing.lists.read', 'inventory.stock.read'],
    },
    { id: 'shipping_clerk', permissions: ['sales.orders.read', 'sales.deliveries.*', 'inventory.stock.read', 'catalog.items.read'] },
    { id: 'sales_manager', permissions: ['sales.*', 'ar.customers.*', 'ar.invoices.*', 'ar.reports.read', 'catalog.items.read', 'pricing.lists.read', 'inventory.stock.read'] },
  ],
  // Whoever takes the order should not also wave it past the customer's credit limit.
  sod: [['sales.orders.write', 'sales.orders.override']],
  health({ db, services }) {
    const progress = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM sales_order_lines l
       WHERE l.delivered_qty <> (SELECT COALESCE(SUM(dl.qty), 0) FROM sales_delivery_lines dl JOIN sales_deliveries d ON d.id = dl.delivery_id
                                 WHERE dl.so_line_id = l.id AND d.status = 'posted')
          OR l.invoiced_qty <> (SELECT COALESCE(SUM(dl.invoiced_qty), 0) FROM sales_delivery_lines dl WHERE dl.so_line_id = l.id)`,
    )!.n;
    let over = 0;
    if (services.has('inventory')) {
      const inv = services.get('inventory');
      for (const r of db.all<{ item_id: number; warehouse_id: number; q: number }>('SELECT item_id, warehouse_id, SUM(qty) q FROM sales_reservations GROUP BY item_id, warehouse_id')) {
        if (r.q > inv.onHand(r.item_id, r.warehouse_id)) over++;
      }
    }
    return [
      { id: 'progress', ok: progress === 0, details: { count: progress } },
      // A stock count or adjustment after reserving can leave less than was promised: advice, not a fault.
      { id: 'reservations', ok: over === 0, severity: 'warning', details: { count: over } },
    ];
  },

  setup(ctx) {
    const svc = createSales(ctx);
    ctx.services.provide('sales', svc as SalesService);
    wireSalesEco(ctx);
    ctx.db.run("INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES ('sales_order', 'SO-', 1, 5)");
    ctx.db.run("INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES ('sales_delivery', 'DLV-', 1, 5)");
    // Reserved stock is not for direct sales invoices (inventory asks through its registry).
    if (ctx.services.has('inventory')) ctx.services.get('inventory').registerReservations((itemId, wh) => (ctx.apps.isEnabled('sd') ? svc.reservedQty(itemId, wh) : 0));
    // Invoices that bill deliveries move the invoiced counters — always, even with the app off, so figures never drift.
    ctx.events.on('document.posted', (e) => e.kind === 'sales_invoice' && svc.onInvoice(e.documentId, 1));
    ctx.events.on('document.voided', (e) => e.kind === 'sales_invoice' && svc.onInvoice(e.documentId, -1));
  },

  routes(r, ctx) {
    const { db, services } = ctx;
    const so = services.get('sales') as unknown as SalesInternal;
    const reports = createReports(ctx);
    const who = (user: SessionUser) => ({ id: user.id, can: (p: string) => user.permissions.has(p) });
    const need = (user: SessionUser, perm: string) => {
      if (!user.permissions.has(perm)) forbidden(perm);
    };

    // ------------------------------------------------------------------ orders
    r.get('/sales/orders', 'sales.orders.read', ({ query }) => {
      const { limit, offset } = paging(query);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.status) (where.push('o.status = :status'), (p.status = query.status));
      if (query.customerId) (where.push('o.customer_id = :cus'), (p.cus = Number(query.customerId)));
      if (query.q) (where.push('(o.number LIKE :q OR o.customer_reference LIKE :q OR pa.name LIKE :q)'), (p.q = `%${query.q}%`));
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.all(
        `SELECT o.*, pa.name AS customer_name,
                (SELECT MIN(COALESCE(l.promised_date, l.requested_date)) FROM sales_order_lines l WHERE l.so_id = o.id AND l.quantity > l.delivered_qty + l.cancelled_qty) AS next_due,
                (SELECT COALESCE(SUM(delivered_qty), 0) * 1.0 / NULLIF(SUM(quantity), 0) FROM sales_order_lines l WHERE l.so_id = o.id) AS delivered_ratio,
                (SELECT COALESCE(SUM(invoiced_qty), 0) * 1.0 / NULLIF(SUM(quantity), 0) FROM sales_order_lines l WHERE l.so_id = o.id) AS invoiced_ratio
         FROM sales_orders o JOIN parties pa ON pa.id = o.customer_id ${w}
         ORDER BY o.order_date DESC, o.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit, offset },
      );
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM sales_orders o JOIN parties pa ON pa.id = o.customer_id ${w}`, p)!.n;
      return { rows, total };
    });

    r.get('/sales/orders/:id', 'sales.orders.read', ({ params }) => {
      const o = so.order(Number(params.id));
      const lines = db
        .all<any>(
          `SELECT l.*, i.sku, i.name_en, i.name_ar, i.unit AS base_unit, i.kind AS item_kind, t.code AS tax_code, COALESCE(r.qty, 0) AS reserved_qty,
                  w.code AS warehouse_code
           FROM sales_order_lines l JOIN items i ON i.id = l.item_id LEFT JOIN taxes t ON t.id = l.tax_id
           LEFT JOIN sales_reservations r ON r.so_line_id = l.id LEFT JOIN warehouses w ON w.id = l.warehouse_id
           WHERE l.so_id = ? ORDER BY l.line_no`,
          [o.id],
        )
        .map((l) => ({ ...l, open_qty: so.openOf(l) }));
      const deliveries = db.all('SELECT id, number, date, status, reference FROM sales_deliveries WHERE so_id = ? ORDER BY id', [o.id]);
      const invoices = db.all(
        `SELECT DISTINCT d.id, d.number, d.date, d.status, d.total FROM documents d JOIN document_lines l ON l.document_id = d.id
         WHERE d.kind = 'sales_invoice' AND l.ext IS NOT NULL
           AND CAST(json_extract(l.ext, '$.soLineId') AS INTEGER) IN (SELECT id FROM sales_order_lines WHERE so_id = ?) ORDER BY d.id`,
        [o.id],
      );
      const customer = services.get('parties').get(o.customer_id);
      const credit = customer.credit_limit != null ? { limit: customer.credit_limit, ...so.creditExposure(customer.id, o.id), order: o.base_total } : null;
      return { ...o, customer, lines, deliveries, invoices, credit };
    });

    r.post('/sales/orders', 'sales.orders.write', ({ body, user }) => {
      const input = parse(zOrder, body);
      if (input.confirm) need(user, 'sales.orders.approve');
      const id = db.tx(() => {
        const id = so.create(input, user.id);
        if (input.confirm) so.confirm(id, { override: input.override }, who(user));
        return id;
      });
      return { id };
    });

    r.put('/sales/orders/:id', 'sales.orders.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zOrder, body);
      if (input.confirm) need(user, 'sales.orders.approve');
      db.tx(() => {
        so.update(id, input, user.id);
        if (input.confirm) so.confirm(id, { override: input.override }, who(user));
      });
      return { id };
    });

    r.post('/sales/orders/:id/confirm', 'sales.orders.approve', ({ params, body, user }) => {
      const input = parse(z.object({ override: z.boolean().default(false) }), body ?? {});
      so.confirm(Number(params.id), input, who(user));
      return { ok: true };
    });
    r.post('/sales/orders/:id/cancel', 'sales.orders.write', ({ params, user }) => (so.cancel(Number(params.id), user.id), { ok: true }));
    r.post('/sales/orders/:id/close', 'sales.orders.write', ({ params, user }) => (so.close(Number(params.id), user.id), { ok: true }));
    r.post('/sales/orders/:id/reschedule', 'sales.orders.approve', ({ params, user }) => (so.reschedule(Number(params.id), user.id), { ok: true }));
    r.put('/sales/orders/:id/lines/:lineId/promise', 'sales.orders.approve', ({ params, body, user }) => {
      const input = parse(z.object({ date: zDate.nullable() }), body);
      const l = so.line(Number(params.lineId));
      if (l.so_id !== Number(params.id)) forbidden();
      so.promise(l.id, input.date, user.id);
      return { ok: true };
    });
    r.delete('/sales/orders/:id', 'sales.orders.write', ({ params, user }) => (so.remove(Number(params.id), user.id), { ok: true }));

    /** Suggested price for a line: the customer's price list, else the item's sale price (base currency, per base unit). */
    r.get('/sales/price', 'sales.orders.read', ({ query }) => {
      const q = parse(z.object({ customerId: zId, itemId: zId }), query);
      const item = services.get('catalog').item(q.itemId);
      const list = services.has('pricing') ? services.get('pricing').listFor(q.customerId) : null;
      const listed = list ? services.get('pricing').price(list.id, item.id, null) : null;
      return { price: listed ?? item.sale_price, source: listed != null ? 'list' : 'item', list };
    });

    // ------------------------------------------------------------- ATP, stock
    r.get('/sales/atp', 'sales.orders.read', ({ query }) => {
      const q = parse(
        z.object({ itemId: zId, qty: z.coerce.number().int().positive(), date: zDate.default(today()), warehouseId: zOptId, excludeLineId: zOptId, asOf: zDate.nullish() }),
        query,
      );
      return so.atp(q);
    });

    r.get('/sales/reservations', 'sales.orders.read', ({ query }) => {
      const itemId = query.itemId ? Number(query.itemId) : null;
      const inv = services.has('inventory') ? services.get('inventory') : null;
      return so.reserved({ itemId, warehouseId: query.warehouseId ? Number(query.warehouseId) : null }).map((x) => {
        const onHand = inv ? inv.onHand(x.itemId, x.warehouseId) : 0;
        return { ...x, onHand, free: Math.max(0, onHand - x.qty) };
      });
    });

    // Planned finished-goods supply by date (the manufacturing integration fills it; editable by hand too).
    r.get('/sales/supply-plan', 'sales.orders.read', ({ query }) =>
      db.all(
        `SELECT p.*, i.sku, i.name_en, i.name_ar FROM sales_supply_plan p JOIN items i ON i.id = p.item_id
         ${query.itemId ? 'WHERE p.item_id = ?' : ''} ORDER BY p.date, i.sku`,
        query.itemId ? [Number(query.itemId)] : [],
      ),
    );
    r.put('/sales/supply-plan', 'sales.supply.write', ({ body, user }) => {
      const input = parse(
        z.object({
          rows: z.array(z.object({ itemId: zId, date: zDate, qty: z.number().int().min(0), source: z.string().trim().min(1).max(40).default('manual'), reference: zOptText(100) })).max(20000),
        }),
        body,
      );
      db.tx(() => {
        for (const x of input.rows) {
          services.get('catalog').item(x.itemId);
          if (x.qty === 0) db.run('DELETE FROM sales_supply_plan WHERE item_id = ? AND date = ? AND source = ?', [x.itemId, x.date, x.source]);
          else
            db.run(
              `INSERT INTO sales_supply_plan (item_id, date, qty, source, reference, updated_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(item_id, date, source) DO UPDATE SET qty = excluded.qty, reference = excluded.reference, updated_at = excluded.updated_at`,
              [x.itemId, x.date, x.qty, x.source, x.reference, nowIso()],
            );
        }
        services.get('audit').log({ userId: user.id, action: 'update', entity: 'sales_supply_plan', summary: `${input.rows.length} rows` });
      });
      return { ok: true };
    });

    // -------------------------------------------------------------- deliveries
    r.get('/sales/deliveries', 'sales.deliveries.read', ({ query }) => {
      const { limit, offset } = paging(query);
      const where: string[] = [];
      const p: Record<string, string | number> = {};
      if (query.status) (where.push('d.status = :status'), (p.status = query.status));
      if (query.soId) (where.push('d.so_id = :so'), (p.so = Number(query.soId)));
      if (query.customerId) (where.push('d.customer_id = :cus'), (p.cus = Number(query.customerId)));
      if (query.toInvoice === '1') where.push("d.status = 'posted' AND EXISTS (SELECT 1 FROM sales_delivery_lines x WHERE x.delivery_id = d.id AND x.qty > x.invoiced_qty)");
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.all(
        `SELECT d.*, o.number AS so_number, o.currency, pa.name AS customer_name,
                (SELECT COALESCE(SUM(qty), 0) FROM sales_delivery_lines x WHERE x.delivery_id = d.id) AS qty,
                (SELECT COALESCE(SUM(invoiced_qty), 0) FROM sales_delivery_lines x WHERE x.delivery_id = d.id) AS invoiced_qty,
                (SELECT COALESCE(SUM(cost), 0) FROM sales_delivery_lines x WHERE x.delivery_id = d.id) AS cost
         FROM sales_deliveries d JOIN sales_orders o ON o.id = d.so_id JOIN parties pa ON pa.id = d.customer_id ${w}
         ORDER BY d.date DESC, d.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit, offset },
      );
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM sales_deliveries d ${w}`, p)!.n;
      return { rows, total };
    });

    r.get('/sales/deliveries/:id', 'sales.deliveries.read', ({ params }) => {
      const d = so.delivery(Number(params.id));
      const o = so.order(d.so_id);
      const lines = db.all<any>(
        `SELECT dl.*, l.line_no AS so_line_no, l.description, l.quantity AS ordered_qty, l.delivered_qty AS so_delivered_qty, l.unit_price, l.discount_bp,
                l.promised_date, l.requested_date, i.sku, i.name_en, i.name_ar, i.unit AS base_unit, i.tracking, w.code AS warehouse_code
         FROM sales_delivery_lines dl JOIN sales_order_lines l ON l.id = dl.so_line_id JOIN items i ON i.id = dl.item_id LEFT JOIN warehouses w ON w.id = dl.warehouse_id
         WHERE dl.delivery_id = ? ORDER BY dl.line_no`,
        [d.id],
      );
      const invoices = db.all(
        `SELECT DISTINCT doc.id, doc.number, doc.date, doc.status FROM documents doc JOIN document_lines l ON l.document_id = doc.id
         WHERE doc.kind = 'sales_invoice' AND l.ext IS NOT NULL AND CAST(json_extract(l.ext, '$.deliveryId') AS INTEGER) = ? ORDER BY doc.id`,
        [d.id],
      );
      const je = (id: number | null) => (id ? db.get<{ number: string }>('SELECT number FROM journal_entries WHERE id = ?', [id])?.number ?? null : null);
      return {
        ...d,
        so_number: o.number,
        currency: o.currency,
        customer: services.get('parties').get(d.customer_id),
        lines: lines.map((l) => ({ ...l, lots: l.lots ? JSON.parse(l.lots) : null })),
        invoices,
        journal_number: je(d.journal_entry_id),
        void_journal_number: je(d.void_entry_id),
      };
    });

    r.post('/sales/deliveries', 'sales.deliveries.write', ({ body, user }) => {
      const input = parse(zDelivery, body);
      if (input.post) need(user, 'sales.deliveries.post');
      const id = db.tx(() => {
        const id = so.createDelivery(input, user.id);
        if (input.post) so.postDelivery(id, user.id);
        return id;
      });
      return { id };
    });
    r.put('/sales/deliveries/:id', 'sales.deliveries.write', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zDelivery, body);
      if (input.post) need(user, 'sales.deliveries.post');
      db.tx(() => {
        so.updateDelivery(id, input, user.id);
        if (input.post) so.postDelivery(id, user.id);
      });
      return { id };
    });
    r.post('/sales/deliveries/:id/post', 'sales.deliveries.post', ({ params, user }) => (so.postDelivery(Number(params.id), user.id), { ok: true }));
    r.post('/sales/deliveries/:id/void', 'sales.deliveries.post', ({ params, body, user }) => {
      const input = parse(z.object({ date: zDate.nullish() }), body ?? {});
      so.voidDelivery(Number(params.id), input, user.id);
      return { ok: true };
    });
    r.delete('/sales/deliveries/:id', 'sales.deliveries.write', ({ params, user }) => (so.removeDelivery(Number(params.id), user.id), { ok: true }));

    /** Deliver one order line now (integration entry point; safe to repeat with the same reference). */
    r.post('/sales/deliveries/deliver-line', 'sales.deliveries.post', ({ body, user }) => {
      const input = parse(z.object({ soLineId: zId, qty: z.number().int().positive(), date: zDate, warehouseId: zOptId, reference: z.string().trim().min(1).max(100) }), body);
      return so.deliverLine({ ...input, userId: user.id });
    });

    /** Bill posted deliveries: a sales invoice with one line per delivery line still to invoice. */
    r.post('/sales/invoices/from-deliveries', 'sales.deliveries.read', ({ body, user }) => {
      const input = parse(z.object({ deliveryIds: z.array(zId).min(1).max(200), date: zDate.default(today()), post: z.boolean().default(false) }), body);
      need(user, 'ar.invoices.write');
      if (input.post) need(user, 'ar.invoices.post');
      return { id: so.invoiceFromDeliveries(input, user.id) };
    });

    // ------------------------------------------------------------------ reports
    r.get('/sales/reports/otif', 'sales.reports.read', ({ query }) => {
      const { from, to } = zMonthRange(query);
      const q = parse(z.object({ groupBy: z.enum(['customer', 'item', 'month']).default('month'), asOf: zDate.nullish() }), query);
      return reports.otif({ from, to, groupBy: q.groupBy, asOf: q.asOf ?? undefined });
    });
    r.get('/sales/reports/backlog', 'sales.reports.read', ({ query }) => {
      const q = parse(z.object({ groupBy: z.enum(['customer', 'item']).default('customer'), asOf: zDate.nullish() }), query);
      return reports.backlog({ groupBy: q.groupBy, asOf: q.asOf ?? undefined });
    });
    r.get('/sales/reports/aging', 'sales.reports.read', ({ query }) => {
      const q = parse(z.object({ asOf: zDate.nullish() }), query);
      return reports.aging({ asOf: q.asOf ?? undefined });
    });
    r.get('/sales/reports/sales', 'sales.reports.read', ({ query }) => {
      const { from, to } = zMonthRange(query);
      const q = parse(z.object({ groupBy: z.enum(['customer', 'item', 'month']).default('customer') }), query);
      return reports.sales({ from, to, groupBy: q.groupBy });
    });
  },
};

