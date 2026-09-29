import { formatQty, type PurchaseRequisitionV1 } from '../../eco-contracts/index.js';
import type { ModuleContext } from '../../kernel/modules.js';
import type {} from '../../contracts/eco.js';
import { PO_V1, type PoLine, type PurchaseOrder } from './orders.js';
import type { RequisitionService } from './requisitions.js';

const uomCode = (unit: string | null | undefined) => (unit ?? '').trim().toUpperCase().slice(0, 64) || 'UNIT';

/**
 * Purchasing in the ecosystem (when the eco module is installed):
 * - publishes acc.purchase_order.v1 for approved orders (open / closed / cancelled): planning counts the
 *   open quantity as supply on each line's expected date. No prices travel.
 * - consumes mes.purchase_requisition.v1: manufacturing's MRP says what is missing; it becomes a requisition.
 */
export function wireEco({ db, services }: ModuleContext, reqs: RequisitionService): void {
  if (!services.has('eco')) return;
  const eco = services.get('eco');
  const hasWarehouses = () => !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'warehouses'");

  eco.registerSnapshot({
    type: PO_V1,
    entity: 'purchase_order',
    all: () => db.all<{ id: number }>("SELECT id FROM purchase_orders WHERE status <> 'draft' ORDER BY id").map((r) => String(r.id)),
    build(localId, h) {
      const po = db.get<PurchaseOrder>('SELECT * FROM purchase_orders WHERE id = ?', [Number(localId)]);
      // Drafts are not commitments yet; an order is published from its approval on.
      if (!po || po.status === 'draft' || !po.number || !hasWarehouses()) return null;
      const wh = db.get<{ id: number; code: string }>(
        po.warehouse_id ? 'SELECT id, code FROM warehouses WHERE id = ?' : 'SELECT id, code FROM warehouses WHERE is_default = 1 ORDER BY id LIMIT 1',
        po.warehouse_id ? [po.warehouse_id] : [],
      );
      if (!wh) return null;
      const supplier = db.get<{ id: number; code: string }>('SELECT id, code FROM parties WHERE id = ?', [po.supplier_id])!;
      const lines = db.all<PoLine & { sku: string; unit: string | null; req_global_id: string | null; req_global_code: string | null }>(
        `SELECT l.*, i.sku, i.unit, q.global_id AS req_global_id, q.global_code AS req_global_code
         FROM purchase_order_lines l JOIN items i ON i.id = l.item_id LEFT JOIN purchase_requisitions q ON q.id = l.requisition_id
         WHERE l.po_id = ? ORDER BY l.line_no`,
        [po.id],
      );
      if (!lines.length) return null; // description-only orders (services) are not supply
      return {
        id: h.id('purchase_order', po.id),
        code: po.number,
        origin: h.origin('purchase_order', po.id),
        supplier: h.ref('party', supplier.id, supplier.code),
        order_date: po.date,
        status: po.status,
        lines: lines.map((l) => ({
          line_no: l.line_no,
          item: h.ref('item', l.item_id!, l.sku),
          qty: formatQty(l.base_quantity),
          received_qty: formatQty(l.received_base),
          uom: uomCode(l.unit),
          expected_date: l.expected_date ?? po.expected_date ?? po.date,
          warehouse: h.ref('warehouse', wh.id, wh.code),
          // Only requisitions that came from manufacturing have a global id to point back to.
          ...(l.req_global_id ? { requisition: { id: l.req_global_id, code: l.req_global_code ?? l.req_global_id } } : {}),
        })),
      };
    },
  });

  eco.registerConsumer<PurchaseRequisitionV1>({ type: 'mes.purchase_requisition.v1', apply: (d) => reqs.applyMrp(d) });
}
