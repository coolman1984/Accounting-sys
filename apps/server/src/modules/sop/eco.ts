import { formatQty } from '../../eco-contracts/index.js';
import type { ModuleContext } from '../../kernel/modules.js';
import type {} from '../../contracts/eco.js';

export const DEMAND_PLAN_V1 = 'acc.demand_plan.v1';

/**
 * The approved S&OP demand plan in the ecosystem: each approved (and later superseded) version is published as
 * acc.demand_plan.v1 — quantities per item and month only, no prices — so manufacturing plans the months that firm
 * orders do not cover yet. Draft versions are not published.
 */
export function wireSopEco({ db, services }: ModuleContext): void {
  if (!services.has('eco')) return;
  services.get('eco').registerSnapshot({
    type: DEMAND_PLAN_V1,
    entity: 'demand_plan',
    all: () => db.all<{ id: number }>("SELECT id FROM sop_versions WHERE status IN ('approved', 'superseded') ORDER BY id").map((r) => String(r.id)),
    build(localId, h) {
      const v = db.get<{ id: number; version_no: number; status: string; approved_at: string | null; period: string }>(
        'SELECT v.id, v.version_no, v.status, v.approved_at, c.period FROM sop_versions v JOIN sop_cycles c ON c.id = v.cycle_id WHERE v.id = ?', [Number(localId)]);
      if (!v || (v.status !== 'approved' && v.status !== 'superseded') || !v.approved_at) return null;
      const lines = db.all<{ item_id: number; sku: string; month: string; qty: number }>(
        'SELECT d.item_id, i.sku, d.month, d.qty FROM sop_demand d JOIN items i ON i.id = d.item_id WHERE d.version_id = ? ORDER BY i.sku, d.month', [v.id]);
      if (!lines.length) return null;
      return {
        id: h.id('demand_plan', v.id),
        code: `SOP-${v.period}-v${v.version_no}`,
        origin: h.origin('demand_plan', v.id),
        cycle: v.period,
        status: v.status,
        approved_at: v.approved_at,
        lines: lines.map((l) => ({ item: h.ref('item', l.item_id, l.sku), period: l.month, qty: formatQty(l.qty) })),
      };
    },
  });
}
