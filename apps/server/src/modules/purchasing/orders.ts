import { z } from 'zod';
import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { computeLine, divRound, sum } from '../../kernel/money.js';
import { zBp, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import type {} from '../../contracts/fx.js';
import type {} from '../../contracts/eco.js';
import type {} from '../../contracts/inventory.js';
import { INCOTERMS } from './schema.js';

export interface PurchaseOrder {
  id: number;
  number: string | null;
  supplier_id: number;
  date: string;
  expected_date: string | null;
  warehouse_id: number | null;
  reference: string | null;
  notes: string | null;
  status: 'draft' | 'open' | 'closed' | 'cancelled';
  subtotal: number;
  tax_total: number;
  total: number;
  /** NULL = the base currency. Amounts of the order and its lines are in this currency. */
  currency: string | null;
  exchange_rate: number | null;
  incoterm: string | null;
  port_of_loading: string | null;
  port_of_discharge: string | null;
}

export interface PoLine {
  id: number;
  po_id: number;
  line_no: number;
  item_id: number | null;
  description: string;
  unit_id: number | null;
  unit_factor: number;
  quantity: number;
  base_quantity: number;
  unit_price: number;
  discount_bp: number;
  tax_id: number | null;
  tax_rate_bp: number;
  net: number;
  tax: number;
  total: number;
  received_base: number;
  billed_base: number;
  expected_date: string | null;
  requisition_id: number | null;
}

export interface PoInput {
  supplierId: number;
  date: string;
  expectedDate: string | null;
  warehouseId: number | null;
  reference: string | null;
  notes: string | null;
  currency?: string | null;
  exchangeRate?: number | null;
  incoterm?: (typeof INCOTERMS)[number] | null;
  portOfLoading?: string | null;
  portOfDischarge?: string | null;
  lines: {
    itemId: number | null;
    description: string | null;
    unitId: number | null;
    quantity: number;
    unitPrice: number;
    discountBp: number;
    taxId: number | null;
    expectedDate?: string | null;
    requisitionId?: number | null;
  }[];
}

export const zPo = z.object({
  supplierId: zId,
  date: zDate,
  expectedDate: zDate.nullish().transform((v) => v ?? null),
  warehouseId: zOptId.transform((v) => v ?? null),
  reference: zOptText(100),
  notes: zOptText(2000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish().transform((v) => v ?? null),
  exchangeRate: z.number().int().positive().nullish().transform((v) => v ?? null),
  incoterm: z.enum(INCOTERMS).nullish().transform((v) => v ?? null),
  portOfLoading: zOptText(100),
  portOfDischarge: zOptText(100),
  lines: z
    .array(
      z.object({
        itemId: zOptId.transform((v) => v ?? null),
        description: zOptText(300),
        unitId: zOptId.transform((v) => v ?? null),
        quantity: z.number().int().positive(),
        unitPrice: z.number().int().min(0),
        discountBp: zBp.default(0),
        taxId: zOptId.transform((v) => v ?? null),
        expectedDate: zDate.nullish().transform((v) => v ?? null),
        requisitionId: zOptId.transform((v) => v ?? null),
      }),
    )
    .min(1)
    .max(500),
  approve: z.boolean().default(false),
});

export const PO_V1 = 'acc.purchase_order.v1';

export type PurchasingService = ReturnType<typeof createPurchasing>;

declare module '../../kernel/services.js' {
  interface ServiceMap {
    purchasing: PurchasingService;
  }
}

/**
 * Purchase orders: what was ordered, what has arrived (goods receipts or
 * bills) and what has been invoiced. Orders never touch the books — they only
 * track the commitment. A foreign-currency order keeps its prices in that
 * currency; receipts value them at the receipt date's rate.
 */
export function createPurchasing({ db, services, apps }: ModuleContext) {
  const catalog = () => services.get('catalog');
  const audit = () => services.get('audit');
  const changed = (id: number) => services.has('eco') && services.get('eco').changed(PO_V1, id);

  const get = (id: number) => db.get<PurchaseOrder>('SELECT * FROM purchase_orders WHERE id = ?', [id]) ?? notFound('purchase_order', id);
  const lines = (id: number) => db.all<PoLine>('SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY line_no', [id]);
  const line = (id: number) => db.get<PoLine>('SELECT * FROM purchase_order_lines WHERE id = ?', [id]) ?? notFound('purchase_order_line', id);

  /** Currency and indicative rate of an order (null currency = base). */
  function currencyOf(input: Pick<PoInput, 'currency' | 'exchangeRate' | 'date'>): { currency: string | null; rate: number | null } {
    const code = input.currency;
    if (!code) return { currency: null, rate: null };
    if (!services.has('fx')) {
      if (code === services.get('settings').company()?.baseCurrency) return { currency: null, rate: null };
      return fail('fx.unavailable', `Multi-currency is not installed: ${code} cannot be used`, { currency: code });
    }
    const fx = services.get('fx');
    if (!fx.isForeign(code)) return { currency: null, rate: null };
    if (!apps.isEnabled('fx')) fail('fx.unavailable', 'Multi-currency is switched off', { currency: code });
    fx.assertCurrency(code);
    let rate = input.exchangeRate ?? null;
    if (rate == null) {
      try {
        rate = fx.rate(code, input.date);
      } catch {
        rate = null; // indicative only: receipts use their own date's rate
      }
    }
    return { currency: code, rate };
  }

  function write(id: number | null, input: PoInput, userId: number | null): number {
    const party = services.get('parties').get(input.supplierId);
    services.get('parties').assertKind(party, 'supplier');
    if (input.warehouseId && services.has('inventory')) services.get('inventory').warehouse(input.warehouseId);
    const { currency, rate } = currencyOf(input);
    const computed = input.lines.map((l, i) => {
      const n = i + 1;
      const item = l.itemId ? catalog().item(l.itemId) : null;
      if (item && !item.is_active) fail('document.inactive_item', `Line ${n}: item ${item.sku} is inactive`, { line: n });
      const description = (l.description ?? '').trim() || item?.name_en || '';
      if (!description) fail('document.line_description', `Line ${n}: description is required`, { line: n });
      if (!item && l.unitId) fail('document.unit_without_item', `Line ${n}: a unit needs an item`, { line: n });
      if (l.expectedDate && l.expectedDate < input.date) fail('po.expected_before_order', `Line ${n}: expected before the order date`, { line: n });
      if (l.requisitionId) {
        const req = db.get<{ item_id: number; status: string; po_id: number | null }>('SELECT item_id, status, po_id FROM purchase_requisitions WHERE id = ?', [l.requisitionId]) ?? notFound('purchase_requisition', l.requisitionId);
        if (req.item_id !== item?.id) fail('requisition.other_item', `Line ${n}: the requisition is for another item`, { line: n });
        if (req.status !== 'open' && !(req.status === 'converted' && req.po_id === id)) conflict('requisition.not_open', `Line ${n}: the requisition is not open`, { line: n });
      }
      const factor = item ? catalog().unitFactor(item, l.unitId) : 1000;
      let taxRate = 0;
      if (l.taxId && services.has('tax') && apps.isEnabled('tax')) {
        const tax = services.get('tax').get(l.taxId);
        if (tax.scope === 'sales') fail('document.tax_scope', `Line ${n}: tax ${tax.code} is not for purchases`, { line: n });
        taxRate = tax.rate_bp;
      }
      const c = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountBp: l.discountBp, rateBp: taxRate }, false);
      return {
        line_no: n,
        item_id: item?.id ?? null,
        description,
        unit_id: l.unitId,
        unit_factor: factor,
        quantity: l.quantity,
        base_quantity: Number(divRound(BigInt(l.quantity) * BigInt(factor), 1000n)),
        unit_price: l.unitPrice,
        discount_bp: l.discountBp,
        tax_id: l.taxId,
        tax_rate_bp: taxRate,
        net: c.net,
        tax: c.tax,
        total: c.total,
        expected_date: l.expectedDate ?? null,
        requisition_id: l.requisitionId ?? null,
      };
    });
    const reqIds = computed.map((l) => l.requisition_id).filter((x): x is number => x != null);
    if (new Set(reqIds).size !== reqIds.length) fail('requisition.twice', 'A requisition can be on one line only');
    const header = {
      supplier_id: input.supplierId,
      date: input.date,
      expected_date: input.expectedDate,
      warehouse_id: input.warehouseId,
      reference: input.reference,
      notes: input.notes,
      currency,
      exchange_rate: rate,
      incoterm: input.incoterm ?? null,
      port_of_loading: input.portOfLoading ?? null,
      port_of_discharge: input.portOfDischarge ?? null,
      subtotal: sum(computed.map((l) => l.net)),
      tax_total: sum(computed.map((l) => l.tax)),
      total: sum(computed.map((l) => l.total)),
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let pid = id;
      if (pid == null) pid = db.insert('purchase_orders', { ...header, status: 'draft', created_by: userId, created_at: nowIso() });
      else {
        db.update('purchase_orders', pid, header);
        db.run('DELETE FROM purchase_order_lines WHERE po_id = ?', [pid]);
      }
      for (const l of computed) db.insert('purchase_order_lines', { ...l, po_id: pid });
      // Requisitions follow their order line: linked ones are converted, dropped ones open again.
      db.run(
        `UPDATE purchase_requisitions SET status = 'open', po_id = NULL, updated_at = ?
         WHERE po_id = ? AND status = 'converted' AND id NOT IN (SELECT requisition_id FROM purchase_order_lines WHERE po_id = ? AND requisition_id IS NOT NULL)`,
        [nowIso(), pid, pid],
      );
      for (const r of reqIds) db.run(`UPDATE purchase_requisitions SET status = 'converted', po_id = ?, updated_at = ? WHERE id = ?`, [pid, nowIso(), r]);
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'purchase_order', entityId: pid });
      changed(pid);
      return pid;
    });
  }

  function approve(id: number, userId: number | null) {
    const po = get(id);
    if (po.status !== 'draft') conflict('po.not_draft', 'Only drafts can be approved');
    db.tx(() => {
      const number = services.get('sequences').next('purchase_order');
      db.run(`UPDATE purchase_orders SET status = 'open', number = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?`, [number, nowIso(), userId, nowIso(), id]);
      audit().log({ userId, action: 'approve', entity: 'purchase_order', entityId: id, summary: number });
      changed(id);
    });
  }

  /** Requisitions of an order: released when it is cancelled or deleted, closed with it, converted again when reopened. */
  function syncRequisitions(poId: number, status: PurchaseOrder['status'] | 'deleted') {
    const now = nowIso();
    if (status === 'cancelled' || status === 'deleted') db.run(`UPDATE purchase_requisitions SET status = 'open', po_id = NULL, updated_at = ? WHERE po_id = ? AND status IN ('converted', 'closed')`, [now, poId]);
    else if (status === 'closed') db.run(`UPDATE purchase_requisitions SET status = 'closed', updated_at = ? WHERE po_id = ? AND status = 'converted'`, [now, poId]);
    else if (status === 'open') db.run(`UPDATE purchase_requisitions SET status = 'converted', updated_at = ? WHERE po_id = ? AND status = 'closed'`, [now, poId]);
  }

  function setStatus(id: number, status: 'closed' | 'cancelled' | 'open', userId: number | null) {
    const po = get(id);
    const ls = lines(id);
    if (status === 'cancelled') {
      if (po.status === 'cancelled' || po.status === 'closed') conflict('po.cannot_cancel', 'This order cannot be cancelled');
      if (ls.some((l) => l.received_base > 0 || l.billed_base > 0)) conflict('po.has_activity', 'Goods were already received or invoiced — close the order instead');
      if (db.get("SELECT 1 FROM letters_of_credit WHERE po_id = ? AND status NOT IN ('cancelled', 'settled')", [id])) conflict('po.has_lc', 'A letter of credit is open on this order — cancel it first');
    }
    if (status === 'closed' && po.status !== 'open') conflict('po.not_open', 'Only open orders can be closed');
    if (status === 'open' && po.status !== 'closed') conflict('po.not_closed', 'Only closed orders can be reopened');
    db.tx(() => {
      db.run('UPDATE purchase_orders SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?', [status, status === 'open' ? null : nowIso(), nowIso(), id]);
      syncRequisitions(id, status);
      audit().log({ userId, action: status === 'open' ? 'reopen' : status === 'closed' ? 'close' : 'cancel', entity: 'purchase_order', entityId: id, summary: po.number });
      changed(id);
    });
  }

  function remove(id: number, userId: number | null) {
    if (get(id).status !== 'draft') conflict('po.not_draft', 'Only drafts can be deleted');
    db.tx(() => {
      syncRequisitions(id, 'deleted');
      db.run('DELETE FROM purchase_orders WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'purchase_order', entityId: id });
    });
  }

  /** Received / invoiced progress. `field` is received_base or billed_base; delta in base units. */
  function track(poLineId: number, field: 'received_base' | 'billed_base', delta: number, ctx: { supplierId: number; itemId: number | null; label: string; currency?: string | null }) {
    const l = line(poLineId);
    const po = get(l.po_id);
    if (po.supplier_id !== ctx.supplierId) fail('po.other_supplier', `${ctx.label}: that order belongs to another supplier`);
    // A line can only count against the order line for the same item.
    if ((l.item_id ?? null) !== (ctx.itemId ?? null)) fail('po.other_item', `${ctx.label}: the item differs from order ${po.number}`, { number: po.number });
    // Receipts and bills of a foreign order are in its currency (3-way match compares like with like).
    if (ctx.currency !== undefined && delta > 0 && (ctx.currency ?? null) !== (po.currency ?? null)) {
      fail('po.currency', `${ctx.label}: order ${po.number} is in ${po.currency ?? 'the base currency'}`, { number: po.number, currency: po.currency });
    }
    if (delta > 0 && po.status !== 'open') fail('po.not_open', `${ctx.label}: order ${po.number} is not open`, { number: po.number });
    const next = l[field] + delta;
    if (next > l.base_quantity) {
      fail('po.over_quantity', `${ctx.label}: more than ordered on ${po.number} (${(l.base_quantity - l[field]) / 1000} left)`, {
        number: po.number,
        left: (l.base_quantity - l[field]) / 1000,
      });
    }
    db.run(`UPDATE purchase_order_lines SET ${field} = ? WHERE id = ?`, [Math.max(0, next), l.id]);
    // Fully received and invoiced => closed automatically (and reopened if a document is voided).
    const all = lines(po.id);
    const done = all.every((x) => x.received_base >= x.base_quantity && x.billed_base >= x.base_quantity);
    if (done && po.status === 'open') {
      db.run(`UPDATE purchase_orders SET status = 'closed', closed_at = ? WHERE id = ?`, [nowIso(), po.id]);
      syncRequisitions(po.id, 'closed');
    }
    if (!done && po.status === 'closed' && delta < 0) {
      db.run(`UPDATE purchase_orders SET status = 'open', closed_at = NULL WHERE id = ?`, [po.id]);
      syncRequisitions(po.id, 'open');
    }
    changed(po.id);
  }

  return { get, lines, line, create: (i: PoInput, u: number | null) => write(null, i, u), update: write, approve, setStatus, remove, track };
}
