import { formatQty, parseQty, type LotDecisionV1 } from '../../eco-contracts/index.js';
import { AppError } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import type { StockDocInput } from './service.js';
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

/** What the lot-decision consumer needs from the inventory service (stock documents are this module's own). */
export interface StockDocs {
  createDoc(input: StockDocInput, userId: number | null): number;
  postDoc(id: number, userId: number | null): void;
}

/**
 * mes.lot_decision.v1 (flow F5): manufacturing's incoming inspection. Rejected or held quantity moves to the quarantine
 * warehouse QA-HOLD (created on first use) with an automatic transfer, reference `eco:<event id>`; a release moves the
 * held quantity back. Accepted lots stay where they are. The supplier return for rejected goods is left to purchasing
 * (a draft debit note is a later step), so no value leaves the books here — a transfer keeps the average cost.
 */
export function consumeLotDecisions({ db, services }: ModuleContext, docs: StockDocs): void {
  if (!services.has('eco')) return;
  const eco = services.get('eco');
  const quarantine = (): number => {
    const w = db.get<{ id: number }>("SELECT id FROM warehouses WHERE code = 'QA-HOLD'");
    if (w) return w.id;
    const id = db.insert('warehouses', { code: 'QA-HOLD', name_en: 'Quality hold (quarantine)', name_ar: 'حجز الجودة', is_default: 0, created_at: nowIso() });
    warehouseChanged(services, db, id);
    return id;
  };
  const move = (date: string, itemId: number, lotNo: string, from: number, to: number, qty: number, ref: string, memo: string) => {
    const item = db.get<{ tracking: string }>('SELECT tracking FROM items WHERE id = ?', [itemId])!;
    const lots = item.tracking === 'none' ? null : [{ lotNo, qty }];
    const id = docs.createDoc({ kind: 'transfer', date, warehouseId: from, toWarehouseId: to, reference: ref, memo, lines: [{ itemId, qty, lots }] }, null);
    docs.postDoc(id, null);
  };

  eco.registerConsumer<LotDecisionV1>({
    type: 'mes.lot_decision.v1',
    apply(d, env) {
      const local = eco.localId('item', d.item.id);
      if (local == null) throw new AppError('mdm.unknown_item', `item ${d.item.code} is not known here`, 409);
      const itemId = Number(local);
      const grLocal = d.goods_receipt ? eco.localId('goods_receipt', d.goods_receipt.id) : null;
      const from = grLocal != null ? db.get<{ warehouse_id: number }>('SELECT warehouse_id FROM goods_receipts WHERE id = ?', [Number(grLocal)])?.warehouse_id : undefined;
      const held = db.get<{ from_warehouse: number; qty: number }>('SELECT from_warehouse, qty FROM stock_quarantine WHERE item_id = ? AND lot_no = ?', [itemId, d.lot_no]);
      const ref = `eco:${env.id}`.slice(0, 100);
      const memo = `${d.decision} ${d.item.code} lot ${d.lot_no}${d.defect_codes.length ? ' (' + d.defect_codes.join(', ') + ')' : ''}`;
      const qa = () => quarantine();

      if (d.decision === 'released' || d.decision === 'accepted') {
        if (!held || held.qty === 0) return 'unchanged';
        move(d.decided_at.slice(0, 10), itemId, d.lot_no, qa(), held.from_warehouse, held.qty, ref, memo);
        db.run('UPDATE stock_quarantine SET qty = 0, updated_at = ? WHERE item_id = ? AND lot_no = ?', [nowIso(), itemId, d.lot_no]);
        return 'applied';
      }
      const source = held?.from_warehouse ?? from ?? services.get('inventory').defaultWarehouse();
      // on hold: the whole received lot (what the receipt brought of it); rejected / partial: the rejected quantity
      let want = parseQty(d.rejected_qty);
      if (d.decision === 'on_hold') {
        const lines = grLocal != null ? db.all<{ base_quantity: number; lots: string | null }>('SELECT base_quantity, lots FROM goods_receipt_lines WHERE receipt_id = ? AND item_id = ?', [Number(grLocal), itemId]) : [];
        want = 0;
        for (const l of lines) {
          const lots = l.lots ? (JSON.parse(l.lots) as { lotNo: string; qty: number }[]) : [];
          want += lots.length ? lots.filter((x) => x.lotNo.toUpperCase() === d.lot_no).reduce((a, x) => a + x.qty, 0) : l.base_quantity;
        }
      }
      const extra = want - (held?.qty ?? 0);
      if (extra <= 0) return 'unchanged';
      move(d.decided_at.slice(0, 10), itemId, d.lot_no, source, qa(), extra, ref, memo);
      db.run(`INSERT INTO stock_quarantine (item_id, lot_no, from_warehouse, qty, rejected, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (item_id, lot_no) DO UPDATE SET qty = excluded.qty, rejected = excluded.rejected, updated_at = excluded.updated_at`,
        [itemId, d.lot_no, source, want, d.decision === 'on_hold' ? 0 : 1, nowIso()]);
      return 'applied';
    },
  });
}

/** Tell the feed a warehouse changed (every warehouse when `id` is omitted, e.g. a new default). */
export function warehouseChanged(services: ModuleContext['services'], db: ModuleContext['db'], id?: number): void {
  if (!services.has('eco')) return;
  const ids = id != null ? [id] : db.all<{ id: number }>('SELECT id FROM warehouses').map((r) => r.id);
  for (const w of ids) services.get('eco').changed(WAREHOUSE_V1, w);
}
