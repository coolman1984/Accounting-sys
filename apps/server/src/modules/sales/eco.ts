import { formatQty, parseQty, type ShipmentDispatchedV1 } from '../../eco-contracts/index.js';
import type { ModuleContext } from '../../kernel/modules.js';
import { AppError } from '../../kernel/errors.js';
import type {} from '../../contracts/eco.js';
import type { DeliverLineInput } from '../../contracts/sales.js';

export interface SalesDelivering {
  deliverLine(input: DeliverLineInput): { deliveryId: number; created: boolean };
  invoiceFromDeliveries(input: { deliveryIds: number[]; date: string; post: boolean }, userId: number | null): number;
}

export const SO_V1 = 'acc.sales_order.v1';

const uomCode = (unit: string | null | undefined) => (unit ?? '').trim().toUpperCase().slice(0, 64) || 'UNIT';
const STATUS: Record<string, 'open' | 'closed' | 'cancelled' | undefined> = { confirmed: 'open', partially_delivered: 'open', closed: 'closed', cancelled: 'cancelled' };

/**
 * Sales orders in the ecosystem: a confirmed order is published as acc.sales_order.v1 (full state, quantities only,
 * no prices) so manufacturing plans against its open quantity. Drafts are not demand yet and are not published.
 */
export function wireSalesEco({ db, services }: ModuleContext, sales: SalesDelivering): void {
  if (!services.has('eco')) return;
  const eco = services.get('eco');

  /**
   * mes.shipment.dispatched.v1 (flow F7): each line that names a sales order line is posted as a delivery (goods issue)
   * dated the plant's production day, reference `eco:<event id>:<line>` so a redelivery never issues twice; then one
   * DRAFT invoice bills what was delivered — the billing clerk checks and posts it. A shipment line without an order,
   * an order that is not open, or more than is left to deliver is refused whole (parked, visible on both sides).
   */
  eco.registerConsumer<ShipmentDispatchedV1>({
    type: 'mes.shipment.dispatched.v1',
    apply(d, env) {
      const deliveries: number[] = [];
      d.lines.forEach((l, i) => {
        if (!l.sales_order) throw new AppError('sales.no_order', `shipment ${d.shipment.code}: ${l.item.code} names no sales order`, 409);
        const soId = eco.localId('sales_order', l.sales_order.id);
        const so = soId == null ? undefined : db.get<{ id: number; status: string; number: string }>('SELECT id, status, number FROM sales_orders WHERE id = ?', [Number(soId)]);
        if (!so) throw new AppError('sales.no_order', `sales order ${l.sales_order.code} is not known here`, 409);
        if (so.status !== 'confirmed' && so.status !== 'partially_delivered') throw new AppError('sales.order_closed', `sales order ${so.number} is ${so.status}`, 409);
        const soLine = db.get<{ id: number }>('SELECT id FROM sales_order_lines WHERE so_id = ? AND line_no = ?', [so.id, l.sales_order.line_no]);
        if (!soLine) throw new AppError('sales.no_order', `sales order ${so.number} has no line ${l.sales_order.line_no}`, 409);
        const wh = eco.localId('warehouse', l.warehouse.id);
        const r = sales.deliverLine({ soLineId: soLine.id, qty: parseQty(l.qty), date: d.production_date, warehouseId: wh == null ? null : Number(wh), reference: `eco:${env.id}:${i + 1}`, lots: l.serials?.length ? l.serials.map((lotNo) => ({ lotNo, qty: 1000 })) : null, userId: null });
        if (r.created) deliveries.push(r.deliveryId);
      });
      if (!deliveries.length) return 'unchanged';
      sales.invoiceFromDeliveries({ deliveryIds: deliveries, date: d.production_date, post: false }, null);
      return 'applied';
    },
  });

  eco.registerSnapshot({
    type: SO_V1,
    entity: 'sales_order',
    all: () => db.all<{ id: number }>("SELECT id FROM sales_orders WHERE status <> 'draft' AND number IS NOT NULL ORDER BY id").map((r) => String(r.id)),
    build(localId, h) {
      const o = db.get<{ id: number; number: string | null; customer_id: number; order_date: string; customer_reference: string | null; ship_to: string | null; priority: number; status: string }>(
        'SELECT id, number, customer_id, order_date, customer_reference, ship_to, priority, status FROM sales_orders WHERE id = ?', [Number(localId)]);
      const status = o && STATUS[o.status];
      if (!o || !o.number || !status) return null;
      const customer = db.get<{ id: number; code: string }>('SELECT id, code FROM parties WHERE id = ?', [o.customer_id]);
      if (!customer) return null;
      const lines = db.all<{ line_no: number; item_id: number; sku: string; unit: string | null; quantity: number; requested_date: string; promised_date: string | null; delivered_qty: number }>(
        `SELECT l.line_no, l.item_id, i.sku, i.unit, l.quantity, l.requested_date, l.promised_date, l.delivered_qty
         FROM sales_order_lines l JOIN items i ON i.id = l.item_id WHERE l.so_id = ? ORDER BY l.line_no`, [o.id]);
      if (!lines.length) return null;
      return {
        id: h.id('sales_order', o.id),
        code: o.number,
        origin: h.origin('sales_order', o.id),
        customer: h.ref('party', customer.id, customer.code),
        order_date: o.order_date,
        ...(o.customer_reference ? { customer_reference: o.customer_reference.slice(0, 80) } : {}),
        status,
        priority: o.priority,
        ...(o.ship_to ? { ship_to: o.ship_to.slice(0, 200) } : {}),
        lines: lines.map((l) => ({
          line_no: l.line_no,
          item: h.ref('item', l.item_id, l.sku),
          qty: formatQty(l.quantity),
          uom: uomCode(l.unit),
          requested_date: l.requested_date,
          ...(l.promised_date ? { promised_date: l.promised_date } : {}),
          delivered_qty: formatQty(l.delivered_qty),
        })),
      };
    },
  });
}
