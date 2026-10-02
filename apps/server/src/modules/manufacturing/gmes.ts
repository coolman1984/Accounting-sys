import { parseQty, type MaterialConsumedV1, type ProductionCompletedV1, type ProductionScrappedV1, type WorkOrderClosedV1 } from '../../eco-contracts/index.js';
import { AppError } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import type { ModuleContext } from '../../kernel/modules.js';
import type {} from '../../contracts/eco.js';
import type {} from '../../contracts/inventory.js';

/**
 * Production recorded by manufacturing (GMES), booked natively (plan 10-MIZAN WP-M4, flow F6). Manufacturing never holds
 * a value; accounting values its facts here, per GMES work order, in its own WIP ledger (`mfg_wip`):
 *  - mes.material.consumed.v1  → the material leaves its warehouse at the moving average: Dr WIP / Cr inventory;
 *  - mes.production.completed.v1 → the product enters at WIP value: a partial completion takes issued × qty / planned
 *    (never more than what is left in WIP); the final one takes all that is left;
 *  - mes.production.scrapped.v1 → no posting (normal scrap is absorbed by the good units), recorded on the WIP row;
 *  - mes.work_order.closed.v1   → what is still in WIP goes to the production variance account.
 * Each posting's reference is `eco:<event id>`; the inbox already applies an event once.
 */
export const gmesWipMigration = {
  id: '002_gmes_wip',
  up: `
    CREATE TABLE mfg_wip (
      id              INTEGER PRIMARY KEY,
      work_order_id   TEXT NOT NULL UNIQUE,        -- GMES's global id of the work order
      code            TEXT NOT NULL,
      item_id         INTEGER,
      planned_qty     INTEGER NOT NULL,
      issued_value    INTEGER NOT NULL DEFAULT 0,
      received_value  INTEGER NOT NULL DEFAULT 0,
      received_qty    INTEGER NOT NULL DEFAULT 0,
      scrapped_qty    INTEGER NOT NULL DEFAULT 0,
      variance        INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      updated_at      TEXT NOT NULL
    );
    ALTER TABLE mfg_settings ADD COLUMN wip_account_id INTEGER REFERENCES accounts(id);
    ALTER TABLE mfg_settings ADD COLUMN variance_account_id INTEGER REFERENCES accounts(id);
  `,
};

interface Wip { id: number; work_order_id: string; code: string; item_id: number | null; planned_qty: number; issued_value: number; received_value: number; received_qty: number; scrapped_qty: number; variance: number; status: string }

export function consumeProduction(ctx: ModuleContext): void {
  const { db, services } = ctx;
  if (!services.has('eco')) return;
  const eco = services.get('eco');
  const inv = () => services.get('inventory');
  const ledger = () => services.get('ledger');

  const account = (col: 'wip_account_id' | 'variance_account_id') => {
    const cur = db.get<Record<string, number | null>>(`SELECT ${col} AS id FROM mfg_settings WHERE id = 1`)!.id;
    if (cur) return cur;
    const id = col === 'wip_account_id'
      ? ledger().ensureAccount({ code: '1145', en: 'Work in Progress (production)', ar: 'إنتاج تحت التشغيل', type: 'asset', subtype: 'current_asset', parentCode: '1100' })
      : ledger().ensureAccount({ code: '5175', en: 'Production Variances', ar: 'انحرافات الإنتاج', type: 'expense', subtype: 'cogs', parentCode: '5000' });
    db.run(`UPDATE mfg_settings SET ${col} = ? WHERE id = 1`, [id]);
    return id;
  };
  const local = (entity: 'item' | 'warehouse', ref: { id: string; code: string }) => {
    const id = eco.localId(entity, ref.id);
    if (id == null) throw new AppError(`mdm.unknown_${entity}`, `${entity} ${ref.code} is not known in accounting`, 409);
    return Number(id);
  };
  const wipOf = (wo: { id: string; code: string; item: { id: string; code: string }; planned_qty: string }): Wip => {
    const cur = db.get<Wip>('SELECT * FROM mfg_wip WHERE work_order_id = ?', [wo.id]);
    if (cur) {
      if (cur.planned_qty !== parseQty(wo.planned_qty) || (cur.item_id != null && String(cur.item_id) !== eco.localId('item', wo.item.id)))
        throw new AppError('mfg.order_mismatch', 'Production facts must retain the released order item and quantity', 409);
      return cur;
    }
    const itemId = eco.localId('item', wo.item.id);
    db.insert('mfg_wip', { work_order_id: wo.id, code: wo.code, item_id: itemId == null ? null : Number(itemId), planned_qty: parseQty(wo.planned_qty), updated_at: nowIso() });
    return db.get<Wip>('SELECT * FROM mfg_wip WHERE work_order_id = ?', [wo.id])!;
  };
  const lots = (lot: string | undefined, qty: number) => (lot ? [{ lotNo: lot, qty }] : null);
  const ref = (id: string) => `eco:${id}`.slice(0, 100);
  const open = (w: Wip) => {
    if (w.status === 'closed') throw new AppError('mfg.wip_closed', `${w.code} is closed; late production facts need reconciliation`, 409);
  };

  eco.registerConsumer<MaterialConsumedV1>({
    type: 'mes.material.consumed.v1',
    apply(d, env) {
      const w = wipOf(d.work_order);
      open(w);
      const qty = parseQty(d.qty);
      const value = inv().wipIssue({ date: d.production_date, sourceId: w.id, reference: ref(env.id), memo: `${d.work_order.code}: ${d.item.code} consumed`, itemId: local('item', d.item),
        warehouseId: local('warehouse', d.warehouse), qty, lots: lots(d.lot_no, qty), wipAccountId: account('wip_account_id') });
      db.run('UPDATE mfg_wip SET issued_value = issued_value + ?, updated_at = ? WHERE id = ?', [value, nowIso(), w.id]);
      return 'applied';
    },
  });

  eco.registerConsumer<ProductionCompletedV1>({
    type: 'mes.production.completed.v1',
    apply(d, env) {
      const w = wipOf(d.work_order);
      open(w);
      const qty = parseQty(d.qty);
      if (parseQty(d.work_order.completed_qty_after) !== w.received_qty + qty || parseQty(d.work_order.scrapped_qty) !== w.scrapped_qty || w.received_qty + w.scrapped_qty + qty > w.planned_qty)
        throw new AppError('mfg.production_sequence', 'Completion totals do not match applied production facts', 409);
      if (d.work_order.is_final !== (w.received_qty + w.scrapped_qty + qty === w.planned_qty))
        throw new AppError('mfg.production_sequence', 'Final completion must exhaust the released order quantity', 409);
      const left = w.issued_value - w.received_value;
      const share = w.planned_qty > 0 ? Math.floor((w.issued_value * qty) / w.planned_qty) : 0;
      const value = d.work_order.is_final ? Math.max(0, left) : Math.max(0, Math.min(share, left));
      inv().wipReceipt({ date: d.production_date, sourceId: w.id, reference: ref(env.id), memo: `${d.work_order.code}: ${d.item.code} completed`, itemId: local('item', d.item),
        warehouseId: local('warehouse', d.warehouse), qty, lots: lots(d.lot_no, qty), wipAccountId: account('wip_account_id'), value });
      db.run('UPDATE mfg_wip SET received_value = received_value + ?, received_qty = received_qty + ?, updated_at = ? WHERE id = ?', [value, qty, nowIso(), w.id]);
      return 'applied';
    },
  });

  eco.registerConsumer<ProductionScrappedV1>({
    type: 'mes.production.scrapped.v1',
    apply(d) {
      const w = wipOf(d.work_order);
      open(w);
      if (w.received_qty + w.scrapped_qty + parseQty(d.qty) > w.planned_qty)
        throw new AppError('mfg.production_sequence', 'Scrap exceeds the remaining released order quantity', 409);
      db.run('UPDATE mfg_wip SET scrapped_qty = scrapped_qty + ?, updated_at = ? WHERE id = ?', [parseQty(d.qty), nowIso(), w.id]);
      return 'applied';
    },
  });

  eco.registerConsumer<WorkOrderClosedV1>({
    type: 'mes.work_order.closed.v1',
    apply(d, env) {
      const w = wipOf(d.work_order);
      if (w.status === 'closed') return 'unchanged';
      if (parseQty(d.work_order.completed_qty) !== w.received_qty || parseQty(d.work_order.scrapped_qty) !== w.scrapped_qty)
        throw new AppError('mfg.production_sequence', 'Close totals do not match applied completion and scrap facts', 409);
      const left = w.issued_value - w.received_value;
      if (left !== 0) {
        const wip = account('wip_account_id'), variance = account('variance_account_id');
        const amount = Math.abs(left);
        ledger().createEntry({ date: d.production_date, reference: ref(env.id), memo: `${d.work_order.code}: production variance at close`,
          lines: left > 0 ? [{ accountId: variance, debit: amount, credit: 0 }, { accountId: wip, debit: 0, credit: amount }] : [{ accountId: wip, debit: amount, credit: 0 }, { accountId: variance, debit: 0, credit: amount }] },
          { sourceType: 'mes_production', sourceId: w.id, userId: null });
      }
      db.run("UPDATE mfg_wip SET status = 'closed', variance = ?, received_value = received_value + ?, updated_at = ? WHERE id = ?", [left, left, nowIso(), w.id]);
      return 'applied';
    },
  });
}
