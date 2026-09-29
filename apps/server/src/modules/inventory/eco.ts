import { formatQty } from '../../eco-contracts/index.js';
import type { ModuleContext } from '../../kernel/modules.js';
import type { Item } from '../../contracts/catalog.js';
import type { Warehouse } from '../../contracts/inventory.js';
import type {} from '../../contracts/eco.js';

export const WAREHOUSE_V1 = 'eco.warehouse.v1';
export const STOCK_POSITION_V1 = 'acc.stock_position.v1';

const uomCode = (unit: string | null | undefined) => (unit ?? '').trim().toUpperCase().slice(0, 64) || 'UNIT';

/**
 * Mizan owns warehouses and the booked stock balance. Published when the integration module is installed:
 * - eco.warehouse.v1 per warehouse;
 * - acc.stock_position.v1 per item × warehouse (on hand from stock_levels, `reserved` from the providers
 *   registered with the eco module — 0 without any), refreshed by every stock move.
 */
export function publishInventory({ db, services }: ModuleContext): void {
  if (!services.has('eco')) return;
  const eco = services.get('eco');

  eco.registerSnapshot({
    type: WAREHOUSE_V1,
    entity: 'warehouse',
    all: () => db.all<{ id: number }>('SELECT id FROM warehouses ORDER BY id').map((r) => String(r.id)),
    build(localId, h) {
      const w = db.get<Warehouse>('SELECT * FROM warehouses WHERE id = ?', [Number(localId)]);
      if (!w) return null;
      return {
        id: h.id('warehouse', w.id),
        code: w.code,
        name: { en: w.name_en, ar: w.name_ar },
        active: !!w.is_active,
        origin: h.origin('warehouse', w.id),
        is_default: !!w.is_default,
      };
    },
  });

  eco.registerSnapshot({
    type: STOCK_POSITION_V1,
    entity: 'stock_position',
    volatile: ['as_of'],
    all: () => db.all<{ k: string }>("SELECT item_id || ':' || warehouse_id AS k FROM stock_levels ORDER BY item_id, warehouse_id").map((r) => r.k),
    build(key, h) {
      const [itemId, warehouseId] = key.split(':').map(Number);
      const item = db.get<Item>('SELECT * FROM items WHERE id = ?', [itemId]);
      const w = db.get<Warehouse>('SELECT * FROM warehouses WHERE id = ?', [warehouseId]);
      if (!item || !w) return null;
      const level = db.get<{ qty: number }>('SELECT qty FROM stock_levels WHERE item_id = ? AND warehouse_id = ?', [itemId, warehouseId]);
      const reserved = eco.reservedQty(itemId, warehouseId);
      if (!level && !reserved) return null;
      return {
        id: h.id('stock_position', key),
        item: h.ref('item', item.id, item.sku),
        warehouse: h.ref('warehouse', w.id, w.code),
        on_hand: formatQty(level?.qty ?? 0),
        reserved: formatQty(reserved),
        uom: uomCode(item.unit),
        as_of: h.now,
        origin: h.origin('stock_position', key),
      };
    },
  });
}

export const GOODS_RECEIPT_V1 = 'acc.goods_receipt.v1';

/**
 * acc.goods_receipt.v1 (flow F5): a posted (or later voided) goods receipt with its lots, so manufacturing can
 * inspect them before use. One contract line per lot; a line without lots is one line. No values travel.
 */
export function publishReceipts({ db, services, events }: ModuleContext): void {
  if (!services.has('eco')) return;
  const eco = services.get('eco');
  eco.registerSnapshot({
    type: GOODS_RECEIPT_V1,
    entity: 'goods_receipt',
    all: () => db.all<{ id: number }>("SELECT id FROM goods_receipts WHERE status IN ('posted', 'void') AND number IS NOT NULL ORDER BY id").map((r) => String(r.id)),
    build(localId, h) {
      const g = db.get<{ id: number; number: string | null; supplier_id: number; po_id: number | null; date: string; warehouse_id: number; status: string }>(
        'SELECT id, number, supplier_id, po_id, date, warehouse_id, status FROM goods_receipts WHERE id = ?', [Number(localId)]);
      if (!g || !g.number || (g.status !== 'posted' && g.status !== 'void')) return null;
      const supplier = db.get<{ id: number; code: string }>('SELECT id, code FROM parties WHERE id = ?', [g.supplier_id]);
      const w = db.get<{ id: number; code: string }>('SELECT id, code FROM warehouses WHERE id = ?', [g.warehouse_id]);
      if (!supplier || !w) return null;
      const po = g.po_id && db.get<{ id: number; number: string | null }>("SELECT id, number FROM purchase_orders WHERE id = ?", [g.po_id]);
      const poLineNo = (id: number | null) => (id ? db.get<{ line_no: number }>('SELECT line_no FROM purchase_order_lines WHERE id = ?', [id])?.line_no : undefined);
      const rows = db.all<{ item_id: number; sku: string; unit: string | null; base_quantity: number; po_line_id: number | null; lots: string | null }>(
        'SELECT l.item_id, i.sku, i.unit, l.base_quantity, l.po_line_id, l.lots FROM goods_receipt_lines l JOIN items i ON i.id = l.item_id WHERE l.receipt_id = ? ORDER BY l.line_no', [g.id]);
      const lines: Record<string, unknown>[] = [];
      for (const r of rows) {
        const lots = r.lots ? (JSON.parse(r.lots) as { lotNo: string; qty: number; expiry?: string | null }[]) : [];
        const base = { item: h.ref('item', r.item_id, r.sku), uom: uomCode(r.unit), ...(poLineNo(r.po_line_id) ? { po_line_no: poLineNo(r.po_line_id) } : {}) };
        if (!lots.length) lines.push({ line_no: lines.length + 1, ...base, qty: formatQty(r.base_quantity) });
        else for (const lot of lots) lines.push({ line_no: lines.length + 1, ...base, qty: formatQty(lot.qty), lot_no: lot.lotNo.slice(0, 64), ...(lot.expiry ? { expiry: lot.expiry } : {}) });
      }
      if (!lines.length) return null;
      return {
        id: h.id('goods_receipt', g.id), code: g.number, origin: h.origin('goods_receipt', g.id),
        ...(po && po.number ? { purchase_order: h.ref('purchase_order', po.id, po.number) } : {}),
        supplier: h.ref('party', supplier.id, supplier.code), receipt_date: g.date, warehouse: h.ref('warehouse', w.id, w.code),
        status: g.status === 'void' ? 'voided' : 'posted', lines,
      };
    },
  });
  events.on('stock.receipt.posted', (e) => eco.changed(GOODS_RECEIPT_V1, e.receiptId));
  events.on('stock.receipt.voided', (e) => eco.changed(GOODS_RECEIPT_V1, e.receiptId));
}

/** Tell the feed a warehouse changed (every warehouse when `id` is omitted, e.g. a new default). */
export function warehouseChanged(services: ModuleContext['services'], db: ModuleContext['db'], id?: number): void {
  if (!services.has('eco')) return;
  const ids = id != null ? [id] : db.all<{ id: number }>('SELECT id FROM warehouses').map((r) => r.id);
  for (const w of ids) services.get('eco').changed(WAREHOUSE_V1, w);
}
