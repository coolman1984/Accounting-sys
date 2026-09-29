import { z } from 'zod';
import { formatQty, parseQty, type PurchaseRequisitionV1 } from '../../eco-contracts/index.js';
import type { ModuleContext, Router } from '../../kernel/modules.js';
import { AppError, conflict, fail, notFound } from '../../kernel/errors.js';
import { addDays, nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import type { Item } from '../../contracts/catalog.js';
import type {} from '../../contracts/eco.js';
import type { PurchasingService } from './orders.js';

export interface Requisition {
  id: number;
  number: string;
  source: 'manual' | 'mrp';
  item_id: number;
  quantity: number;
  need_date: string;
  order_by_date: string | null;
  warehouse_id: number | null;
  supplier_id: number | null;
  status: 'open' | 'converted' | 'closed' | 'cancelled';
  pegging: string | null;
  notes: string | null;
  global_id: string | null;
  global_code: string | null;
  global_version: number | null;
  mrp_run: string | null;
  po_id: number | null;
}

const zRequisition = z.object({
  itemId: zId,
  quantity: z.number().int().positive(),
  needDate: zDate,
  orderByDate: zDate.nullish().transform((v) => v ?? null),
  warehouseId: zOptId.transform((v) => v ?? null),
  supplierId: zOptId.transform((v) => v ?? null),
  notes: zOptText(1000),
});

const zConvert = z.object({
  ids: z.array(zId).min(1).max(500),
  supplierId: zOptId.transform((v) => v ?? null),
  date: zDate.nullish().transform((v) => v ?? null),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish().transform((v) => v ?? null),
  /** Round each quantity up to the item's MOQ and lot size (default on). */
  applyLotSizing: z.boolean().default(true),
});

/** Order quantity after MOQ and lot sizing (all x1000). */
export function sizeOrder(item: Pick<Item, 'moq' | 'lot_size_rule' | 'lot_size'>, need: number): number {
  let q = Math.max(need, item.moq || 0);
  if (item.lot_size > 0 && item.lot_size_rule === 'fixed') q = Math.ceil(q / item.lot_size) * item.lot_size;
  if (item.lot_size > 0 && item.lot_size_rule === 'multiple') q = Math.ceil(q / item.lot_size) * item.lot_size;
  return q;
}

const pegText = (p: PurchaseRequisitionV1['pegging']) => (p.length ? p.map((x) => `${x.kind} ${x.reference}: ${x.qty}`).join('\n') : null);

/**
 * Purchase requisitions: a need for a purchased material, typed by a planner (manual) or concluded by
 * manufacturing's MRP (mes.purchase_requisition.v1, source mrp). Purchasing decides whether, from whom
 * and at what price to buy: converting one or several (same supplier) creates a draft order, one line
 * per requisition, each line keeping its requisition.
 */
export function createRequisitions(ctx: ModuleContext, po: () => PurchasingService) {
  const { db, services } = ctx;
  const catalog = () => services.get('catalog');
  const audit = () => services.get('audit');

  const get = (id: number) => db.get<Requisition>('SELECT * FROM purchase_requisitions WHERE id = ?', [id]) ?? notFound('purchase_requisition', id);

  const checkRefs = (itemId: number, warehouseId: number | null, supplierId: number | null) => {
    const item = catalog().item(itemId);
    if (item.kind !== 'product') fail('requisition.not_product', `${item.sku} is a service`, { sku: item.sku });
    if (warehouseId && services.has('inventory')) services.get('inventory').warehouse(warehouseId);
    if (supplierId) {
      const p = services.get('parties').get(supplierId);
      if (p.kind === 'customer') fail('party.not_supplier', `${p.name} is not a supplier`);
    }
    return item;
  };

  function create(input: z.infer<typeof zRequisition> & { source?: 'manual' | 'mrp'; pegging?: string | null; globalId?: string | null; globalCode?: string | null; globalVersion?: number | null; mrpRun?: string | null }, userId: number | null): number {
    const item = checkRefs(input.itemId, input.warehouseId, input.supplierId);
    return db.tx(() => {
      const number = services.get('sequences').next('purchase_requisition');
      const id = db.insert('purchase_requisitions', {
        number,
        source: input.source ?? 'manual',
        item_id: item.id,
        quantity: input.quantity,
        need_date: input.needDate,
        order_by_date: input.orderByDate ?? addDays(input.needDate, -(item.lead_time_days ?? 0)),
        warehouse_id: input.warehouseId,
        supplier_id: input.supplierId ?? item.default_supplier_id ?? null,
        status: 'open',
        pegging: input.pegging ?? null,
        notes: input.notes,
        global_id: input.globalId ?? null,
        global_code: input.globalCode ?? null,
        global_version: input.globalVersion ?? null,
        mrp_run: input.mrpRun ?? null,
        created_by: userId,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      audit().log({ userId, action: 'create', entity: 'purchase_requisition', entityId: id, summary: number });
      return id;
    });
  }

  function update(id: number, input: z.infer<typeof zRequisition>, userId: number | null) {
    const r = get(id);
    if (r.status !== 'open') conflict('requisition.not_open', 'Only open requisitions can be changed');
    if (r.source === 'mrp') conflict('requisition.from_mrp', 'This requisition comes from planning: change it there (or cancel it)');
    const item = checkRefs(input.itemId, input.warehouseId, input.supplierId);
    db.tx(() => {
      db.update('purchase_requisitions', id, {
        item_id: item.id,
        quantity: input.quantity,
        need_date: input.needDate,
        order_by_date: input.orderByDate ?? addDays(input.needDate, -(item.lead_time_days ?? 0)),
        warehouse_id: input.warehouseId,
        supplier_id: input.supplierId ?? item.default_supplier_id ?? null,
        notes: input.notes,
        updated_at: nowIso(),
      });
      audit().log({ userId, action: 'update', entity: 'purchase_requisition', entityId: id, summary: r.number });
    });
  }

  function setStatus(id: number, status: 'cancelled' | 'closed' | 'open', userId: number | null) {
    const r = get(id);
    if (status === 'open' ? !['cancelled', 'closed'].includes(r.status) || r.po_id != null : r.status !== 'open') {
      conflict('requisition.status', `A ${r.status} requisition cannot become ${status}`, { status: r.status });
    }
    db.tx(() => {
      db.run('UPDATE purchase_requisitions SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
      audit().log({ userId, action: status === 'open' ? 'reopen' : status === 'closed' ? 'close' : 'cancel', entity: 'purchase_requisition', entityId: id, summary: r.number });
    });
  }

  /** Convert open requisitions of ONE supplier into a draft order (one line each, linked). */
  function convert(input: z.infer<typeof zConvert>, userId: number | null): number {
    const reqs = [...new Set(input.ids)].map(get);
    for (const r of reqs) if (r.status !== 'open') conflict('requisition.not_open', `${r.number} is not open`, { number: r.number });
    const suppliers = new Set(reqs.map((r) => r.supplier_id).filter((x): x is number => x != null));
    const supplierId = input.supplierId ?? (suppliers.size === 1 ? [...suppliers][0] : null);
    if (!supplierId) fail(suppliers.size > 1 ? 'requisition.supplier_mixed' : 'requisition.supplier_required', suppliers.size > 1 ? 'These requisitions have different suppliers' : 'Choose the supplier');
    // A requisition without a suggested supplier joins the one of the others (or the one chosen).
    if (input.supplierId && suppliers.size > 1) fail('requisition.supplier_mixed', 'These requisitions have different suppliers');
    const warehouses = new Set(reqs.map((r) => r.warehouse_id ?? 0));
    if (warehouses.size > 1) fail('requisition.warehouse_mixed', 'These requisitions are for different warehouses: convert them separately');
    const date = input.date ?? today();
    const ordered = [...reqs].sort((a, b) => a.need_date.localeCompare(b.need_date) || a.id - b.id);
    return db.tx(() => {
      const id = po().create(
        {
          supplierId: supplierId!,
          date,
          expectedDate: ordered[0].need_date,
          warehouseId: ordered[0].warehouse_id,
          reference: null,
          notes: `From ${ordered.map((r) => r.number).join(', ')}`.slice(0, 2000),
          currency: input.currency,
          lines: ordered.map((r) => {
            const item = catalog().item(r.item_id);
            return {
              itemId: r.item_id,
              description: null,
              unitId: null,
              quantity: input.applyLotSizing ? sizeOrder(item, r.quantity) : r.quantity,
              unitPrice: input.currency ? 0 : item.purchase_price,
              discountBp: 0,
              taxId: item.purchase_tax_id,
              expectedDate: r.need_date < date ? date : r.need_date,
              requisitionId: r.id,
            };
          }),
        },
        userId,
      );
      audit().log({ userId, action: 'convert', entity: 'purchase_requisition', summary: `${ordered.map((r) => r.number).join(', ')} → order ${id}` });
      return id;
    });
  }

  /**
   * mes.purchase_requisition.v1 from manufacturing: a newer version updates the requisition while it is
   * still open (once converted, purchasing owns what happens next); `cancelled` withdraws an open one.
   */
  function applyMrp(d: PurchaseRequisitionV1): 'applied' | 'unchanged' | 'stale' {
    const eco = services.get('eco');
    const cur = db.get<Requisition>('SELECT * FROM purchase_requisitions WHERE global_id = ?', [d.id]);
    if (cur && cur.global_version != null && d.version < cur.global_version) return 'stale';
    if (cur && cur.global_version === d.version) return 'unchanged';
    const itemLocal = eco.localId('item', d.item.id);
    if (itemLocal == null) throw new AppError('eco.unknown_item', `item ${d.item.code} (${d.item.id}) is not a Mizan item`, 400);
    const whLocal = eco.localId('warehouse', d.warehouse.id);
    if (whLocal == null) throw new AppError('eco.unknown_warehouse', `warehouse ${d.warehouse.code} (${d.warehouse.id}) is not a Mizan warehouse`, 400);
    const item = catalog().item(Number(itemLocal));
    const base = (item.unit ?? '').trim().toUpperCase().slice(0, 64) || 'UNIT';
    if (d.uom !== base) throw new AppError('eco.uom_mismatch', `${d.item.code} is counted in ${base}, the requisition says ${d.uom}`, 400);
    const quantity = parseQty(d.qty);
    const fields = {
      item_id: item.id,
      quantity,
      need_date: d.need_date,
      order_by_date: d.order_by_date,
      warehouse_id: Number(whLocal),
      pegging: pegText(d.pegging),
      global_code: d.code,
      global_version: d.version,
      mrp_run: d.mrp_run.code,
      updated_at: nowIso(),
    };
    if (!cur) {
      if (d.status === 'cancelled') return 'unchanged'; // withdrawn before it ever arrived
      create(
        { itemId: item.id, quantity, needDate: d.need_date, orderByDate: d.order_by_date, warehouseId: Number(whLocal), supplierId: null, notes: null, source: 'mrp', pegging: fields.pegging, globalId: d.id, globalCode: d.code, globalVersion: d.version, mrpRun: d.mrp_run.code },
        null,
      );
      return 'applied';
    }
    if (cur.status !== 'open') {
      // Already converted, closed or cancelled here: remember the version, change nothing.
      db.run('UPDATE purchase_requisitions SET global_version = ?, updated_at = ? WHERE id = ?', [d.version, nowIso(), cur.id]);
      return 'unchanged';
    }
    if (d.status === 'cancelled') {
      db.run("UPDATE purchase_requisitions SET status = 'cancelled', global_version = ?, updated_at = ? WHERE id = ?", [d.version, nowIso(), cur.id]);
      audit().log({ userId: null, action: 'cancel', entity: 'purchase_requisition', entityId: cur.id, summary: `${cur.number} withdrawn by planning (${d.mrp_run.code})` });
      return 'applied';
    }
    const same = cur.item_id === fields.item_id && cur.quantity === quantity && cur.need_date === d.need_date && cur.order_by_date === d.order_by_date && cur.warehouse_id === fields.warehouse_id && (cur.pegging ?? null) === fields.pegging;
    db.update('purchase_requisitions', cur.id, fields);
    return same ? 'unchanged' : 'applied';
  }

  return { get, create, update, setStatus, convert, applyMrp };
}

export type RequisitionService = ReturnType<typeof createRequisitions>;

export function requisitionRoutes(r: Router, { db, services }: ModuleContext, reqs: RequisitionService) {
  r.get('/purchase-requisitions', 'purchasing.requisitions.read', ({ query }) => {
    const where: string[] = [];
    const p: Record<string, string | number> = {};
    if (query.status) (where.push('q.status = :status'), (p.status = query.status));
    if (query.source) (where.push('q.source = :source'), (p.source = query.source));
    return db.all(
      `SELECT q.*, i.sku, i.name_en, i.name_ar, i.unit AS base_unit, i.lead_time_days, i.moq, i.lot_size_rule, i.lot_size, i.purchase_price,
              sp.name AS supplier_name, o.number AS po_number,
              ${services.has('inventory') ? 'w.code' : 'NULL'} AS warehouse_code
       FROM purchase_requisitions q JOIN items i ON i.id = q.item_id
       LEFT JOIN parties sp ON sp.id = q.supplier_id LEFT JOIN purchase_orders o ON o.id = q.po_id
       ${services.has('inventory') ? 'LEFT JOIN warehouses w ON w.id = q.warehouse_id' : ''}
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE q.status WHEN 'open' THEN 0 WHEN 'converted' THEN 1 ELSE 2 END, q.order_by_date, q.need_date, q.id LIMIT 20000`,
      p,
    );
  });
  r.get('/purchase-requisitions/:id', 'purchasing.requisitions.read', ({ params }) => {
    const q = reqs.get(parse(zId, params.id));
    const item = services.get('catalog').item(q.item_id);
    return { ...q, item, supplier: q.supplier_id ? services.get('parties').get(q.supplier_id) : null, po: q.po_id ? services.get('purchasing').get(q.po_id) : null, quantity_text: formatQty(q.quantity) };
  });
  r.post('/purchase-requisitions', 'purchasing.requisitions.write', ({ body, user }) => ({ id: reqs.create(parse(zRequisition, body), user.id) }));
  r.put('/purchase-requisitions/:id', 'purchasing.requisitions.write', ({ params, body, user }) => (reqs.update(parse(zId, params.id), parse(zRequisition, body), user.id), { ok: true }));
  r.post('/purchase-requisitions/:id/cancel', 'purchasing.requisitions.write', ({ params, user }) => (reqs.setStatus(parse(zId, params.id), 'cancelled', user.id), { ok: true }));
  r.post('/purchase-requisitions/:id/close', 'purchasing.requisitions.write', ({ params, user }) => (reqs.setStatus(parse(zId, params.id), 'closed', user.id), { ok: true }));
  r.post('/purchase-requisitions/:id/reopen', 'purchasing.requisitions.write', ({ params, user }) => (reqs.setStatus(parse(zId, params.id), 'open', user.id), { ok: true }));
  // Creates a DRAFT order: approving it stays a separate right (purchasing.orders.approve).
  r.post('/purchase-requisitions/convert', 'purchasing.orders.write', ({ body, user }) => ({ id: reqs.convert(parse(zConvert, body), user.id) }));
}
