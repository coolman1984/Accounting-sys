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

/** Tell the feed a warehouse changed (every warehouse when `id` is omitted, e.g. a new default). */
export function warehouseChanged(services: ModuleContext['services'], db: ModuleContext['db'], id?: number): void {
  if (!services.has('eco')) return;
  const ids = id != null ? [id] : db.all<{ id: number }>('SELECT id FROM warehouses').map((r) => r.id);
  for (const w of ids) services.get('eco').changed(WAREHOUSE_V1, w);
}
