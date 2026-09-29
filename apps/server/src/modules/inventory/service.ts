import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { lineAmount } from '../../kernel/money.js';
import type { Item } from '../../contracts/catalog.js';
import type {} from '../../contracts/fx.js';
import type { IssueInput, IssueResult, LineCost, ProductionInput, ProductionResult, WipMoveInput } from '../../contracts/inventory.js';
import { KIND_INFO, type DocKind, type DocumentLine } from '../../contracts/documents.js';
import { STOCK_SEQ, type StockDocKind } from './schema.js';
import { createEngine, mulDiv, split, type Diff, type PostMeta, type StockMove } from './engine.js';

export type { StockMove } from './engine.js';

export interface Warehouse {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  address: string | null;
  is_active: number;
  is_default: number;
}

export interface LotInput {
  lotNo: string;
  expiry?: string | null;
  qty: number;
}

export interface StockDocLineInput {
  itemId: number;
  qty: number;
  unitId?: number | null;
  unitCost?: number | null;
  note?: string | null;
  lots?: LotInput[] | null;
}

export interface StockDocInput {
  kind: StockDocKind;
  date: string;
  warehouseId: number;
  toWarehouseId?: number | null;
  counterAccountId?: number | null;
  reference?: string | null;
  memo?: string | null;
  lines: StockDocLineInput[];
}

export interface StockDoc {
  id: number;
  kind: StockDocKind;
  number: string | null;
  date: string;
  warehouse_id: number;
  to_warehouse_id: number | null;
  counter_account_id: number | null;
  reference: string | null;
  memo: string | null;
  status: 'draft' | 'posted' | 'void';
  journal_entry_id: number | null;
  void_entry_id: number | null;
  created_at: string;
  posted_at: string | null;
}

interface DocLine {
  id: number;
  line_no: number;
  item_id: number;
  qty: number;
  unit_id: number | null;
  unit_factor: number;
  unit_cost: number | null;
  system_qty: number | null;
  note: string | null;
  lots: string | null;
}

export interface ReceiptInput {
  supplierId: number;
  poId?: number | null;
  date: string;
  warehouseId: number;
  reference?: string | null;
  notes?: string | null;
  /** Currency of the unit costs (a foreign purchase order's); null = base. */
  currency?: string | null;
  /** Rate for that currency; null = the rate of the receipt date. */
  exchangeRate?: number | null;
  lines: { itemId: number; description?: string | null; unitId?: number | null; quantity: number; unitCost: number; poLineId?: number | null; lots?: LotInput[] | null }[];
}

export interface Receipt {
  id: number;
  number: string | null;
  supplier_id: number;
  po_id: number | null;
  date: string;
  warehouse_id: number;
  reference: string | null;
  notes: string | null;
  status: 'draft' | 'posted' | 'void';
  journal_entry_id: number | null;
  void_entry_id: number | null;
  currency: string | null;
  exchange_rate: number | null;
}

export interface ReceiptLine {
  id: number;
  receipt_id: number;
  line_no: number;
  item_id: number;
  description: string | null;
  unit_id: number | null;
  unit_factor: number;
  quantity: number;
  base_quantity: number;
  unit_cost: number;
  value: number;
  po_line_id: number | null;
  lots: string | null;
  billed_base: number;
  billed_value: number;
}

export interface LandedCostInput {
  date: string;
  counterAccountId: number;
  amount: number;
  method: 'value' | 'qty';
  reference?: string | null;
  memo?: string | null;
  targets: { sourceType: 'purchase_bill' | 'goods_receipt'; sourceId: number }[];
}

export interface LandedCost {
  id: number;
  number: string | null;
  date: string;
  counter_account_id: number;
  amount: number;
  method: 'value' | 'qty';
  reference: string | null;
  memo: string | null;
  status: 'draft' | 'posted' | 'void';
  journal_entry_id: number | null;
  void_entry_id: number | null;
}

export type InventoryService = ReturnType<typeof createInventory>;

const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
const parseJson = (s: string | null): unknown => (s ? JSON.parse(s) : null);

/**
 * Perpetual inventory: warehouses, lots & serials, moving weighted-average cost,
 * goods receipts with GRNI matching, landed costs and automatic re-costing.
 * After every operation the inventory accounts equal the stock valuation.
 */
export function createInventory(ctx: ModuleContext) {
  const { db, services, events } = ctx;
  const engine = createEngine(ctx);
  const ledger = () => services.get('ledger');
  const catalog = () => services.get('catalog');
  const audit = () => services.get('audit');
  const { move, moveIn, moveOut, reverseMove, postDifference, linkEntry, inventoryAccount, cogsAccount } = engine;

  // ------------------------------------------------------------- warehouses
  function warehouse(id: number): Warehouse {
    return db.get<Warehouse>('SELECT * FROM warehouses WHERE id = ?', [id]) ?? notFound('warehouse', id);
  }

  function activeWarehouse(id: number): Warehouse {
    const w = warehouse(id);
    if (!w.is_active) fail('stock.warehouse_inactive', `Warehouse ${w.code} is inactive`, { code: w.code });
    return w;
  }

  // ------------------------------------------------- sales & purchase documents

  /** What the document itself posted to the item's inventory account for a line (debit-positive). */
  function ledgerEffect(kind: DocKind, net: number): number {
    if (kind === 'purchase_bill') return net;
    if (kind === 'purchase_credit') return -net;
    return 0;
  }

  /** Account a purchase line of a stock item should use (called by documents when it computes lines). */
  function purchaseLineAccount(_item: Item, ext: Record<string, unknown> | null): number | null {
    return ext?.receiptLineId ? engine.grniAccount() : null;
  }

  type DocLineRow = DocumentLine;

  /** Stock promised to customers (sales reservations), registered by the sales module. */
  let reservedBy: ((itemId: number, warehouseId: number) => number) | null = null;

  /** Quantity (base) a delivery line took out of stock, net of any reversal. */
  const issuedByDelivery = (deliveryLineId: number, itemId: number) =>
    db.get<{ q: number }>("SELECT -COALESCE(SUM(qty), 0) q FROM stock_moves WHERE source_type = 'sales_delivery' AND source_line_id = ? AND item_id = ?", [deliveryLineId, itemId])!.q;

  function onDocumentPosted(documentId: number, userId: number | null): void {
    const docs = services.get('documents');
    const doc = docs.get(documentId);
    const lines = docs.lines(documentId) as (DocLineRow & { base_quantity: number; unit_factor: number; ext: string | null })[];
    const info = KIND_INFO[doc.kind];
    const stockLines = lines
      .map((l) => ({ l, item: l.item_id ? catalog().item(l.item_id) : null }))
      .filter((x): x is { l: (typeof lines)[number]; item: Item } => !!x.item && catalog().isStockItem(x.item));
    if (stockLines.length === 0) return;
    const meta: PostMeta = { date: doc.date, memo: `${doc.number} — cost of goods`, reference: doc.number, sourceType: 'cogs', sourceId: doc.id, userId };

    engine.operation(meta, () => {
      const headerWh = doc.warehouse_id ?? engine.defaultWarehouse();
      const diffs: Diff[] = [];
      const moveIds: number[] = [];

      for (const { l, item } of stockLines) {
        const wh = activeWarehouse(l.warehouse_id ?? headerWh).id;
        const ext = (parseJson(l.ext) ?? {}) as Record<string, unknown>;
        const lotsReq = engine.parseLots(ext.lots, l.unit_factor, l.line_no);
        const invAcc = inventoryAccount(item);
        const base = { date: doc.date, itemId: item.id, warehouseId: wh, sourceType: doc.kind, sourceId: doc.id, sourceLineId: l.id, userId };

        // Billing of a posted delivery: the goods (and their cost) already left with the delivery.
        if (doc.kind === 'sales_invoice' && ext.deliveryLineId != null) {
          const issued = issuedByDelivery(Number(ext.deliveryLineId), item.id);
          if (issued <= 0 || l.base_quantity > issued) {
            fail('stock.delivery_not_issued', `Line ${l.line_no}: the delivery of ${item.sku} is not posted (or covers less)`, { line: l.line_no, sku: item.sku });
          }
          continue;
        }
        if (doc.kind === 'sales_invoice' && reservedBy) {
          const reserved = reservedBy(item.id, wh);
          const free = engine.level(item.id, wh) - reserved;
          if (reserved > 0 && l.base_quantity > free) {
            fail('stock.reserved', `Line ${l.line_no}: ${item.sku} is reserved for sales orders — only ${Math.max(0, free) / 1000} is free`, {
              line: l.line_no,
              sku: item.sku,
              free: Math.max(0, free) / 1000,
              reserved: reserved / 1000,
            });
          }
        }

        if (info.side === 'purchases') {
          if (item.tracking === 'serial' && l.unit_factor !== 1000) fail('stock.serial_units', `Line ${l.line_no}: serial items are counted one by one`, { line: l.line_no });
          if (ext.receiptLineId) {
            if (doc.kind !== 'purchase_bill') fail('grn.match_kind', `Line ${l.line_no}: only supplier invoices can match a goods receipt`, { line: l.line_no });
            const d = matchReceipt(doc.party_id, l, item, Number(ext.receiptLineId), meta);
            diffs.push(...d.diffs);
            moveIds.push(...d.moveIds);
            continue;
          }
          if (l.account_id !== invAcc) {
            fail('stock.line_account', `Line ${l.line_no}: stock item ${item.sku} must be booked to its inventory account`, { line: l.line_no, sku: item.sku });
          }
        }

        let moves: StockMove[];
        if (doc.kind === 'purchase_bill') {
          moves = moveIn(engine.allocateIn(item, l.base_quantity, lotsReq, l.line_no), l.base_net, base);
        } else if (doc.kind === 'sales_credit') {
          // Returns against an invoice come back at the cost they left at (and, for tracked items, into the lots they left from).
          // An invoice made from deliveries did not move stock itself: the goods left with the deliveries.
          const deliveryLines = doc.against_document_id
            ? docs
                .lines(doc.against_document_id)
                .filter((x) => x.item_id === item.id && x.ext)
                .map((x) => Number((parseJson(x.ext) as Record<string, unknown>)?.deliveryLineId ?? 0))
                .filter((x) => x > 0)
            : [];
          const sold = doc.against_document_id
            ? db.all<{ lot_id: number | null; qty: number; value: number }>(
                `SELECT lot_id, -SUM(qty) qty, -SUM(value) value FROM stock_moves
                 WHERE item_id = ? AND ((source_type = 'sales_invoice' AND source_id = ?)
                    OR (source_type = 'sales_delivery' AND source_line_id IN (${deliveryLines.map(() => '?').join(',') || 'NULL'})))
                 GROUP BY lot_id HAVING SUM(qty) < 0`,
                [item.id, doc.against_document_id, ...deliveryLines],
              )
            : [];
          const soldQty = sold.reduce((s, x) => s + x.qty, 0);
          const soldValue = sold.reduce((s, x) => s + x.value, 0);
          const value = soldQty > 0 ? mulDiv(soldValue, l.base_quantity, soldQty) : engine.averageValue(item, l.base_quantity);
          let parts;
          if (item.tracking !== 'none' && !lotsReq.length && sold.length) {
            parts = [];
            let left = l.base_quantity;
            for (const s of sold) {
              if (left <= 0) break;
              const take = Math.min(left, s.qty);
              parts.push({ lotId: s.lot_id, qty: take });
              left -= take;
            }
            if (left > 0) fail('stock.lot_required', `Line ${l.line_no}: more returned than sold — enter the lots`, { line: l.line_no, sku: item.sku });
          } else parts = engine.allocateIn(item, l.base_quantity, lotsReq, l.line_no);
          moves = moveIn(parts, value, base);
        } else {
          // sales_invoice & purchase_credit: goods leave at average cost
          const parts = engine.allocateOut(item, wh, l.base_quantity, lotsReq, { date: doc.date, allowExpired: doc.kind === 'purchase_credit', line: l.line_no });
          moves = moveOut(parts, base);
        }
        moves.forEach((m) => moveIds.push(m.id));
        const value = moves.reduce((s, m) => s + m.value, 0);
        diffs.push({ invAccount: invAcc, counterAccount: cogsAccount(item), amount: value - ledgerEffect(doc.kind, l.base_net) });
      }
      linkEntry(moveIds, postDifference(diffs, meta));
    });
  }

  /**
   * A supplier invoice line for goods already received: no stock moves again.
   * Its amount clears GRNI; the price difference versus the receipt goes to the
   * stock still on hand (and cost of sales for what was already used).
   */
  function matchReceipt(
    supplierId: number,
    l: { id: number; line_no: number; base_quantity: number; net: number; base_net: number; account_id: number },
    item: Item,
    receiptLineId: number,
    meta: PostMeta,
  ): { diffs: Diff[]; moveIds: number[] } {
    const g = db.get<ReceiptLine>('SELECT * FROM goods_receipt_lines WHERE id = ?', [receiptLineId]) ?? notFound('receipt_line', receiptLineId);
    const r = receipt(g.receipt_id);
    if (r.status !== 'posted') fail('grn.not_posted', `Line ${l.line_no}: goods receipt ${r.number ?? ''} is not posted`, { line: l.line_no });
    if (r.supplier_id !== supplierId) fail('grn.other_supplier', `Line ${l.line_no}: that receipt belongs to another supplier`, { line: l.line_no });
    if (g.item_id !== item.id) fail('grn.other_item', `Line ${l.line_no}: that receipt line is for another item`, { line: l.line_no });
    const grni = engine.grniAccount();
    if (l.account_id !== grni) fail('grn.line_account', `Line ${l.line_no}: invoiced receipts are booked to Goods Received Not Invoiced`, { line: l.line_no });
    const remaining = g.base_quantity - g.billed_base;
    if (l.base_quantity > remaining) {
      fail('grn.over_billed', `Line ${l.line_no}: only ${remaining / 1000} of ${item.sku} is left to invoice on ${r.number}`, { line: l.line_no, remaining: remaining / 1000, number: r.number });
    }
    const clearing = l.base_quantity === remaining ? g.value - g.billed_value : mulDiv(g.value, l.base_quantity, g.base_quantity);
    db.run('UPDATE goods_receipt_lines SET billed_base = billed_base + ?, billed_value = billed_value + ? WHERE id = ?', [l.base_quantity, clearing, g.id]);
    const variance = l.base_net - clearing;
    const p = engine.pool(item.id);
    let toInv = p.qty <= 0 ? 0 : p.qty >= l.base_quantity ? variance : mulDiv(variance, p.qty, l.base_quantity);
    if (p.value + toInv < 0) toInv = -p.value;
    const mv = engine.revalue({ itemId: item.id, value: toInv, date: meta.date, sourceType: 'grn_variance', sourceId: meta.sourceId, sourceLineId: l.id, userId: meta.userId });
    db.insert('receipt_matches', { document_line_id: l.id, receipt_line_id: g.id, base_quantity: l.base_quantity, clearing, to_inventory: toInv, to_cogs: variance - toInv });
    return {
      moveIds: mv ? [mv.id] : [],
      diffs: [
        { invAccount: inventoryAccount(item), counterAccount: grni, amount: toInv },
        { invAccount: cogsAccount(item), counterAccount: grni, amount: variance - toInv },
      ],
    };
  }

  /** Freight / customs booked on a purchase must be voided before the purchase itself. */
  function assertNoLandedCosts(sourceType: 'goods_receipt' | 'purchase_bill', sourceId: number) {
    const lc = db.get<{ number: string }>(
      `SELECT lc.number FROM landed_cost_targets t JOIN landed_costs lc ON lc.id = t.landed_cost_id
       WHERE t.source_type = ? AND t.source_id = ? AND lc.status = 'posted' LIMIT 1`,
      [sourceType, sourceId],
    );
    if (lc) conflict('landed.has_costs', `Landed cost ${lc.number} is booked on this purchase — void it first`, { number: lc.number });
  }

  function onDocumentVoided(documentId: number, date: string, userId: number | null): void {
    const docs = services.get('documents');
    const doc = docs.get(documentId);
    if (doc.kind === 'purchase_bill') assertNoLandedCosts('purchase_bill', doc.id);
    const moves = db.all<StockMove>('SELECT * FROM stock_moves WHERE source_type = ? AND source_id = ? AND is_reversal = 0 ORDER BY id DESC', [doc.kind, doc.id]);
    const lineIds = docs.lines(doc.id).map((l) => l.id);
    const matches = lineIds.length
      ? db.all<{ document_line_id: number; receipt_line_id: number; base_quantity: number; clearing: number; to_inventory: number; to_cogs: number }>(
          `SELECT * FROM receipt_matches WHERE document_line_id IN (${lineIds.map(() => '?').join(',')})`,
          lineIds,
        )
      : [];
    if (!moves.length && !matches.length) return;
    const meta: PostMeta = { date, memo: `Void ${doc.number} — cost of goods`, reference: doc.number, sourceType: 'cogs', sourceId: doc.id, userId };
    engine.operation(meta, () => {
      const lineNet = new Map(docs.lines(doc.id).map((l) => [l.id, l.base_net]));
      const diffs: Diff[] = [];
      const moveIds: number[] = [];
      for (const m of moves) {
        const item = catalog().item(m.item_id);
        const rev = reverseMove(m, date, userId)!;
        moveIds.push(rev.id);
        const ledgerReversal = -ledgerEffect(doc.kind, lineNet.get(m.source_line_id ?? 0) ?? 0);
        diffs.push({ invAccount: inventoryAccount(item), counterAccount: cogsAccount(item), amount: rev.value - ledgerReversal });
      }
      // Undo receipt matching: the receipt becomes invoiceable again and the price difference is taken back.
      const grni = matches.length ? engine.grniAccount() : 0;
      for (const mt of matches) {
        const g = db.get<ReceiptLine>('SELECT * FROM goods_receipt_lines WHERE id = ?', [mt.receipt_line_id])!;
        const item = catalog().item(g.item_id);
        db.run('UPDATE goods_receipt_lines SET billed_base = billed_base - ?, billed_value = billed_value - ? WHERE id = ?', [mt.base_quantity, mt.clearing, g.id]);
        db.run('DELETE FROM receipt_matches WHERE document_line_id = ?', [mt.document_line_id]);
        const p = engine.pool(item.id);
        let back = p.qty > 0 ? -mt.to_inventory : 0;
        if (p.value + back < 0) back = -p.value;
        const mv = engine.revalue({ itemId: item.id, value: back, date, sourceType: 'grn_variance', sourceId: doc.id, sourceLineId: mt.document_line_id, userId });
        if (mv) moveIds.push(mv.id);
        const variance = mt.to_inventory + mt.to_cogs;
        diffs.push({ invAccount: inventoryAccount(item), counterAccount: grni, amount: back });
        diffs.push({ invAccount: cogsAccount(item), counterAccount: grni, amount: -variance - back });
      }
      linkEntry(moveIds, postDifference(diffs, meta));
    });
  }

  // --------------------------------------------------------- stock documents
  function stockDoc(id: number): StockDoc {
    return db.get<StockDoc>('SELECT * FROM stock_docs WHERE id = ?', [id]) ?? notFound('stock_document', id);
  }

  function docLines(id: number): DocLine[] {
    return db.all<DocLine>('SELECT * FROM stock_doc_lines WHERE doc_id = ? ORDER BY line_no', [id]);
  }

  function validateDoc(input: StockDocInput): void {
    activeWarehouse(input.warehouseId);
    if (input.kind === 'transfer') {
      if (!input.toWarehouseId) fail('stock.transfer_target', 'Choose the destination warehouse');
      if (input.toWarehouseId === input.warehouseId) fail('stock.transfer_same', 'Source and destination must differ');
      activeWarehouse(input.toWarehouseId!);
    }
    if (input.counterAccountId) {
      const a = ledger().account(input.counterAccountId);
      if (a.is_group || !a.is_active) fail('stock.counter_account', `${a.code} cannot be used`);
      if (['inventory', 'receivable', 'payable'].includes(a.subtype)) fail('stock.counter_account', 'Choose an expense, income or equity account');
    }
    if (!input.lines.length) fail('stock.no_lines', 'Add at least one line');
    const seen = new Set<number>();
    input.lines.forEach((l, i) => {
      const n = i + 1;
      const item = catalog().item(l.itemId);
      if (!catalog().isStockItem(item)) fail('stock.not_stock_item', `Line ${n}: ${item.sku} is not a stock item`, { line: n, sku: item.sku });
      catalog().unitFactor(item, l.unitId);
      if (item.tracking === 'serial' && l.unitId) fail('stock.serial_units', `Line ${n}: serial items are counted one by one`, { line: n });
      if (input.kind === 'count') {
        if (seen.has(l.itemId)) fail('stock.duplicate_item', `Line ${n}: ${item.sku} is counted twice`, { line: n, sku: item.sku });
        if (l.qty < 0) fail('stock.invalid_qty', `Line ${n}: counted quantity cannot be negative`, { line: n });
      } else if (input.kind === 'adjustment') {
        if (l.qty === 0) fail('stock.invalid_qty', `Line ${n}: enter a quantity`, { line: n });
      } else if (l.qty <= 0) fail('stock.invalid_qty', `Line ${n}: quantity must be positive`, { line: n });
      if (l.unitCost != null && l.unitCost < 0) fail('stock.invalid_value', `Line ${n}: invalid cost`, { line: n });
      seen.add(l.itemId);
    });
  }

  function writeDoc(id: number | null, input: StockDocInput, userId: number | null): number {
    validateDoc(input);
    const row = {
      kind: input.kind,
      date: input.date,
      warehouse_id: input.warehouseId,
      to_warehouse_id: input.kind === 'transfer' ? input.toWarehouseId ?? null : null,
      counter_account_id: input.kind === 'transfer' ? null : input.counterAccountId ?? null,
      reference: input.reference ?? null,
      memo: input.memo ?? null,
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let docId = id;
      if (docId == null) docId = db.insert('stock_docs', { ...row, status: 'draft', created_by: userId, created_at: nowIso() });
      else {
        db.update('stock_docs', docId, row);
        db.run('DELETE FROM stock_doc_lines WHERE doc_id = ?', [docId]);
      }
      input.lines.forEach((l, i) => {
        const item = catalog().item(l.itemId);
        db.insert('stock_doc_lines', {
          doc_id: docId,
          line_no: i + 1,
          item_id: l.itemId,
          qty: l.qty,
          unit_id: l.unitId ?? null,
          unit_factor: catalog().unitFactor(item, l.unitId),
          unit_cost: l.unitCost ?? null,
          note: l.note ?? null,
          lots: l.lots?.length ? json(l.lots) : null,
        });
      });
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'stock_document', entityId: docId, summary: input.kind });
      return docId;
    });
  }

  function counterFor(doc: StockDoc): number {
    if (doc.counter_account_id) return doc.counter_account_id;
    return doc.kind === 'opening' ? ledger().defaultAccount('capital') : engine.adjustmentAccount();
  }

  /** Value of incoming base quantity: unit cost is per line unit; none = current average. */
  function incomingValue(item: Item, baseQty: number, unitCost: number | null, factor: number): number {
    return unitCost != null ? mulDiv(baseQty, unitCost, factor) : engine.averageValue(item, baseQty);
  }

  function postDoc(id: number, userId: number | null): void {
    const doc = stockDoc(id);
    if (doc.status !== 'draft') conflict('stock.not_draft', 'Already posted');
    const lines = docLines(id);
    validateDoc({
      kind: doc.kind,
      date: doc.date,
      warehouseId: doc.warehouse_id,
      toWarehouseId: doc.to_warehouse_id,
      counterAccountId: doc.counter_account_id,
      lines: lines.map((l) => ({ itemId: l.item_id, qty: l.qty, unitId: l.unit_id, unitCost: l.unit_cost })),
    });
    ledger().assertPostingDate(doc.date);
    db.tx(() => {
      const number = services.get('sequences').next(STOCK_SEQ[doc.kind][0]);
      db.run(`UPDATE stock_docs SET number = ?, updated_at = ? WHERE id = ?`, [number, nowIso(), id]);
      const meta: PostMeta = { date: doc.date, memo: doc.memo ?? number, reference: number, sourceType: `stock_${doc.kind}`, sourceId: doc.id, userId };
      engine.operation(meta, () => {
        const counter = doc.kind === 'transfer' ? 0 : counterFor(doc);
        const diffs: Diff[] = [];
        const moveIds: number[] = [];
        for (const l of lines) {
          const item = catalog().item(l.item_id);
          const base = { date: doc.date, itemId: item.id, sourceType: doc.kind, sourceId: doc.id, sourceLineId: l.id, userId };
          const lotsReq = engine.parseLots(parseJson(l.lots), l.unit_factor, l.line_no);
          const baseQty = mulDiv(l.qty, l.unit_factor, 1000);
          let moves: StockMove[] = [];

          if (doc.kind === 'transfer') {
            const parts = engine.allocateOut(item, doc.warehouse_id, baseQty, lotsReq, { date: doc.date, allowExpired: true, line: l.line_no });
            for (const p of parts) {
              const out = move({ ...base, warehouseId: doc.warehouse_id, qty: -p.qty, lotId: p.lotId });
              const inn = move({ ...base, warehouseId: doc.to_warehouse_id!, qty: p.qty, value: -out.value, lotId: p.lotId });
              moveIds.push(out.id, inn.id);
            }
            continue;
          }

          if (doc.kind === 'count') {
            const book = engine.level(item.id, doc.warehouse_id);
            db.run('UPDATE stock_doc_lines SET system_qty = ? WHERE id = ?', [book, l.id]);
            if (item.tracking === 'none') {
              const delta = baseQty - book;
              if (delta > 0) moves = moveIn([{ lotId: null, qty: delta }], incomingValue(item, delta, l.unit_cost, l.unit_factor), { ...base, warehouseId: doc.warehouse_id });
              else if (delta < 0) moves = moveOut([{ lotId: null, qty: -delta }], { ...base, warehouseId: doc.warehouse_id });
            } else {
              // Tracked items are counted lot by lot; book lots not listed were not found (counted zero).
              const counted = new Map<string, { qty: number; expiry: string | null }>();
              for (const r of lotsReq) counted.set(r.lotNo, { qty: (counted.get(r.lotNo)?.qty ?? 0) + r.qty, expiry: r.expiry });
              const total = [...counted.values()].reduce((s, x) => s + x.qty, 0);
              if (total !== baseQty) fail('stock.lot_qty_mismatch', `Line ${l.line_no}: lot quantities (${total / 1000}) must add up to ${baseQty / 1000}`, { line: l.line_no, lots: total / 1000, qty: baseQty / 1000 });
              const bookLots = db.all<{ lot_id: number; lot_no: string; qty: number }>(
                `SELECT ll.lot_id, l.lot_no, ll.qty FROM lot_levels ll JOIN stock_lots l ON l.id = ll.lot_id
                 WHERE l.item_id = ? AND ll.warehouse_id = ? AND ll.qty > 0`,
                [item.id, doc.warehouse_id],
              );
              for (const b of bookLots) {
                const c = counted.get(b.lot_no)?.qty ?? 0;
                if (c < b.qty) moves.push(...moveOut([{ lotId: b.lot_id, qty: b.qty - c }], { ...base, warehouseId: doc.warehouse_id }));
              }
              for (const [lotNo, c] of counted) {
                const b = bookLots.find((x) => x.lot_no === lotNo)?.qty ?? 0;
                if (c.qty > b) {
                  const add = c.qty - b;
                  const parts = engine.allocateIn(item, add, [{ lotNo, expiry: c.expiry, qty: add }], l.line_no);
                  moves.push(...moveIn(parts, incomingValue(item, add, l.unit_cost, l.unit_factor), { ...base, warehouseId: doc.warehouse_id }));
                }
              }
            }
          } else if (baseQty > 0) {
            // adjustment up / opening stock
            const parts = engine.allocateIn(item, baseQty, lotsReq, l.line_no);
            moves = moveIn(parts, incomingValue(item, baseQty, l.unit_cost, l.unit_factor), { ...base, warehouseId: doc.warehouse_id });
          } else {
            const parts = engine.allocateOut(item, doc.warehouse_id, -baseQty, lotsReq, { date: doc.date, allowExpired: true, line: l.line_no });
            moves = moveOut(parts, { ...base, warehouseId: doc.warehouse_id });
          }
          for (const m of moves) {
            moveIds.push(m.id);
            diffs.push({ invAccount: inventoryAccount(item), counterAccount: counter, amount: m.value });
          }
        }
        const entry = postDifference(diffs, meta);
        linkEntry(moveIds, entry);
        db.run(`UPDATE stock_docs SET status = 'posted', journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE id = ?`, [entry, nowIso(), nowIso(), id]);
      });
      audit().log({ userId, action: 'post', entity: 'stock_document', entityId: id, summary: number });
    });
  }

  function voidDoc(id: number, opts: { date?: string | null }, userId: number | null): void {
    const doc = stockDoc(id);
    if (doc.status !== 'posted') conflict('stock.not_posted', 'Only posted documents can be voided');
    const date = opts.date ?? doc.date;
    ledger().assertPostingDate(date);
    db.tx(() => {
      const meta: PostMeta = { date, memo: `Void ${doc.number}`, reference: doc.number, sourceType: `stock_${doc.kind}`, sourceId: doc.id, userId };
      engine.operation(meta, () => {
        const moves = db.all<StockMove>('SELECT * FROM stock_moves WHERE source_type = ? AND source_id = ? AND is_reversal = 0 ORDER BY id DESC', [doc.kind, doc.id]);
        const counter = doc.kind === 'transfer' ? engine.adjustmentAccount() : counterFor(doc);
        const diffs: Diff[] = [];
        const moveIds: number[] = [];
        for (const m of moves) {
          const rev = reverseMove(m, date, userId)!;
          moveIds.push(rev.id);
          diffs.push({ invAccount: inventoryAccount(catalog().item(m.item_id)), counterAccount: counter, amount: rev.value });
        }
        const entry = postDifference(diffs, meta);
        linkEntry(moveIds, entry);
        db.run(`UPDATE stock_docs SET status = 'void', void_entry_id = ?, voided_at = ?, updated_at = ? WHERE id = ?`, [entry, nowIso(), nowIso(), id]);
      });
      audit().log({ userId, action: 'void', entity: 'stock_document', entityId: id, summary: doc.number });
    });
  }

  function removeDoc(id: number, userId: number | null): void {
    const doc = stockDoc(id);
    if (doc.status !== 'draft') conflict('stock.not_draft', 'Only drafts can be deleted — void posted documents');
    db.tx(() => {
      db.run('DELETE FROM stock_docs WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'stock_document', entityId: id, summary: doc.kind });
    });
  }

  // ---------------------------------------------------------- goods receipts
  function receipt(id: number): Receipt {
    return db.get<Receipt>('SELECT * FROM goods_receipts WHERE id = ?', [id]) ?? notFound('goods_receipt', id);
  }

  function receiptLines(id: number): ReceiptLine[] {
    return db.all<ReceiptLine>('SELECT * FROM goods_receipt_lines WHERE receipt_id = ? ORDER BY line_no', [id]);
  }

  function writeReceipt(id: number | null, input: ReceiptInput, userId: number | null): number {
    const party = services.get('parties').get(input.supplierId);
    services.get('parties').assertKind(party, 'supplier');
    activeWarehouse(input.warehouseId);
    if (!input.lines.length) fail('stock.no_lines', 'Add at least one line');
    // Foreign currency: costs are typed in that currency and valued at the receipt date's rate.
    let currency: string | null = null;
    let rate: number | null = null;
    if (input.currency && services.has('fx') && services.get('fx').isForeign(input.currency)) {
      const fx = services.get('fx');
      currency = fx.assertCurrency(input.currency).code;
      rate = input.exchangeRate ?? fx.rate(currency, input.date);
      if (!Number.isSafeInteger(rate) || rate <= 0) fail('fx.invalid_rate', 'Invalid exchange rate');
    } else if (input.currency && (!services.has('fx') || services.get('fx').isForeign(input.currency))) {
      fail('fx.unavailable', `Multi-currency is not installed: ${input.currency} cannot be used`, { currency: input.currency });
    }
    const toBase = (v: number) => (rate == null ? v : services.get('fx').toBase(v, rate));
    const lines = input.lines.map((l, i) => {
      const n = i + 1;
      const item = catalog().item(l.itemId);
      if (!catalog().isStockItem(item)) fail('stock.not_stock_item', `Line ${n}: ${item.sku} is not a stock item`, { line: n, sku: item.sku });
      if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0) fail('stock.invalid_qty', `Line ${n}: invalid quantity`, { line: n });
      if (!Number.isSafeInteger(l.unitCost) || l.unitCost < 0) fail('stock.invalid_value', `Line ${n}: invalid cost`, { line: n });
      const factor = catalog().unitFactor(item, l.unitId);
      if (item.tracking === 'serial' && factor !== 1000) fail('stock.serial_units', `Line ${n}: serial items are counted one by one`, { line: n });
      return {
        line_no: n,
        item_id: item.id,
        description: l.description ?? null,
        unit_id: l.unitId ?? null,
        unit_factor: factor,
        quantity: l.quantity,
        base_quantity: mulDiv(l.quantity, factor, 1000),
        unit_cost: toBase(l.unitCost),
        value: toBase(lineAmount(l.quantity, l.unitCost)),
        unit_cost_fx: rate == null ? null : l.unitCost,
        value_fx: rate == null ? null : lineAmount(l.quantity, l.unitCost),
        po_line_id: l.poLineId ?? null,
        lots: l.lots?.length ? json(l.lots) : null,
      };
    });
    const row = {
      supplier_id: input.supplierId,
      currency,
      exchange_rate: rate,
      po_id: input.poId ?? null,
      date: input.date,
      warehouse_id: input.warehouseId,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let rid = id;
      if (rid == null) rid = db.insert('goods_receipts', { ...row, status: 'draft', created_by: userId, created_at: nowIso() });
      else {
        db.update('goods_receipts', rid, row);
        db.run('DELETE FROM goods_receipt_lines WHERE receipt_id = ?', [rid]);
      }
      for (const l of lines) db.insert('goods_receipt_lines', { ...l, receipt_id: rid });
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'goods_receipt', entityId: rid });
      return rid;
    });
  }

  function postReceipt(id: number, userId: number | null): void {
    const r = receipt(id);
    if (r.status !== 'draft') conflict('stock.not_draft', 'Already posted');
    activeWarehouse(r.warehouse_id);
    ledger().assertPostingDate(r.date);
    const grni = engine.grniAccount();
    db.tx(() => {
      const number = services.get('sequences').next('goods_receipt');
      db.run('UPDATE goods_receipts SET number = ?, updated_at = ? WHERE id = ?', [number, nowIso(), id]);
      const supplier = services.get('parties').get(r.supplier_id);
      const meta: PostMeta = { date: r.date, memo: `${number} — ${supplier.name}`, reference: r.reference ?? number, sourceType: 'goods_receipt', sourceId: r.id, userId };
      engine.operation(meta, () => {
        const diffs: Diff[] = [];
        const moveIds: number[] = [];
        for (const l of receiptLines(id)) {
          const item = catalog().item(l.item_id);
          const parts = engine.allocateIn(item, l.base_quantity, engine.parseLots(parseJson(l.lots), l.unit_factor, l.line_no), l.line_no);
          const moves = moveIn(parts, l.value, { date: r.date, itemId: item.id, warehouseId: r.warehouse_id, sourceType: 'goods_receipt', sourceId: r.id, sourceLineId: l.id, userId });
          moves.forEach((m) => moveIds.push(m.id));
          diffs.push({ invAccount: inventoryAccount(item), counterAccount: grni, amount: l.value });
        }
        const entry = postDifference(diffs, meta);
        linkEntry(moveIds, entry);
        db.run(`UPDATE goods_receipts SET status = 'posted', journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE id = ?`, [entry, nowIso(), nowIso(), id]);
      });
      audit().log({ userId, action: 'post', entity: 'goods_receipt', entityId: id, summary: number });
      events.emit('stock.receipt.posted', { receiptId: id, userId });
    });
  }

  function voidReceipt(id: number, opts: { date?: string | null }, userId: number | null): void {
    const r = receipt(id);
    if (r.status !== 'posted') conflict('stock.not_posted', 'Only posted receipts can be voided');
    if (receiptLines(id).some((l) => l.billed_base > 0)) conflict('grn.billed', 'This receipt is already invoiced — void the supplier invoice first');
    assertNoLandedCosts('goods_receipt', id);
    const date = opts.date ?? r.date;
    ledger().assertPostingDate(date);
    const grni = engine.grniAccount();
    db.tx(() => {
      const meta: PostMeta = { date, memo: `Void ${r.number}`, reference: r.number, sourceType: 'goods_receipt', sourceId: r.id, userId };
      engine.operation(meta, () => {
        const diffs: Diff[] = [];
        const moveIds: number[] = [];
        const moves = db.all<StockMove>("SELECT * FROM stock_moves WHERE source_type = 'goods_receipt' AND source_id = ? AND is_reversal = 0 ORDER BY id DESC", [r.id]);
        for (const m of moves) {
          const rev = reverseMove(m, date, userId)!;
          moveIds.push(rev.id);
          const item = catalog().item(m.item_id);
          // GRNI is cleared by the received value; any change in average cost since goes to cost of sales.
          diffs.push({ invAccount: inventoryAccount(item), counterAccount: grni, amount: rev.value });
          diffs.push({ invAccount: cogsAccount(item), counterAccount: grni, amount: -(m.value + rev.value) });
        }
        const entry = postDifference(diffs, meta);
        linkEntry(moveIds, entry);
        db.run(`UPDATE goods_receipts SET status = 'void', void_entry_id = ?, voided_at = ?, updated_at = ? WHERE id = ?`, [entry, nowIso(), nowIso(), id]);
      });
      audit().log({ userId, action: 'void', entity: 'goods_receipt', entityId: id, summary: r.number });
      events.emit('stock.receipt.voided', { receiptId: id, userId });
    });
  }

  // ------------------------------------------------------------ landed costs
  function landedCost(id: number): LandedCost {
    return db.get<LandedCost>('SELECT * FROM landed_costs WHERE id = ?', [id]) ?? notFound('landed_cost', id);
  }

  function writeLandedCost(id: number | null, input: LandedCostInput, userId: number | null): number {
    const a = ledger().account(input.counterAccountId);
    if (a.is_group || !a.is_active) fail('landed.counter_account', `${a.code} cannot be used`);
    if (['inventory', 'receivable', 'payable'].includes(a.subtype)) fail('landed.counter_account', 'Choose the account the costs were booked to (clearing, expense, cash or bank)');
    if (!input.targets.length) fail('landed.no_targets', 'Choose the purchases these costs belong to');
    for (const t of input.targets) {
      const status = t.sourceType === 'purchase_bill' ? services.get('documents').get(t.sourceId).status : receipt(t.sourceId).status;
      if (status !== 'posted') fail('landed.target_not_posted', 'Only posted purchases can receive landed costs');
    }
    const row = {
      date: input.date,
      counter_account_id: input.counterAccountId,
      amount: input.amount,
      method: input.method,
      reference: input.reference ?? null,
      memo: input.memo ?? null,
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let lid = id;
      if (lid == null) lid = db.insert('landed_costs', { ...row, status: 'draft', created_by: userId, created_at: nowIso() });
      else {
        db.update('landed_costs', lid, row);
        db.run('DELETE FROM landed_cost_targets WHERE landed_cost_id = ?', [lid]);
      }
      for (const t of input.targets) db.insert('landed_cost_targets', { landed_cost_id: lid, source_type: t.sourceType, source_id: t.sourceId });
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'landed_cost', entityId: lid });
      return lid;
    });
  }

  /** Goods received by the chosen purchases, per item (base qty and value). */
  function landedCostBasis(id: number) {
    return db.all<{ item_id: number; qty: number; value: number }>(
      `SELECT m.item_id, SUM(m.qty) qty, SUM(m.value) value
       FROM landed_cost_targets t JOIN stock_moves m ON m.source_type = t.source_type AND m.source_id = t.source_id
       WHERE t.landed_cost_id = ? AND m.qty > 0 AND m.is_reversal = 0 GROUP BY m.item_id ORDER BY m.item_id`,
      [id],
    );
  }

  function postLandedCost(id: number, userId: number | null): void {
    const lc = landedCost(id);
    if (lc.status !== 'draft') conflict('stock.not_draft', 'Already posted');
    ledger().assertPostingDate(lc.date);
    const basis = landedCostBasis(id);
    if (!basis.length) fail('landed.no_goods', 'The chosen purchases contain no stock items');
    db.tx(() => {
      const number = services.get('sequences').next('landed_cost');
      db.run('UPDATE landed_costs SET number = ?, updated_at = ? WHERE id = ?', [number, nowIso(), id]);
      const meta: PostMeta = { date: lc.date, memo: lc.memo ?? `${number} — landed costs`, reference: lc.reference ?? number, sourceType: 'landed_cost', sourceId: id, userId };
      engine.operation(meta, () => {
        const shares = split(lc.amount, basis.map((b) => (lc.method === 'qty' ? b.qty : b.value)));
        const diffs: Diff[] = [];
        const moveIds: number[] = [];
        basis.forEach((b, i) => {
          const item = catalog().item(b.item_id);
          const amount = shares[i];
          // Only the part of the goods still on hand can carry the extra cost; the rest was already sold.
          const p = engine.pool(item.id);
          const toInv = p.qty <= 0 ? 0 : p.qty >= b.qty ? amount : mulDiv(amount, p.qty, b.qty);
          const mv = engine.revalue({ itemId: item.id, value: toInv, date: lc.date, sourceType: 'landed_cost', sourceId: id, userId });
          if (mv) moveIds.push(mv.id);
          db.insert('landed_cost_allocations', {
            landed_cost_id: id,
            item_id: item.id,
            received_qty: b.qty,
            received_value: b.value,
            amount,
            to_inventory: toInv,
            to_cogs: amount - toInv,
          });
          diffs.push({ invAccount: inventoryAccount(item), counterAccount: lc.counter_account_id, amount: toInv });
          diffs.push({ invAccount: cogsAccount(item), counterAccount: lc.counter_account_id, amount: amount - toInv });
        });
        const entry = postDifference(diffs, meta);
        linkEntry(moveIds, entry);
        db.run(`UPDATE landed_costs SET status = 'posted', journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE id = ?`, [entry, nowIso(), nowIso(), id]);
      });
      audit().log({ userId, action: 'post', entity: 'landed_cost', entityId: id, summary: number });
    });
  }

  function voidLandedCost(id: number, opts: { date?: string | null }, userId: number | null): void {
    const lc = landedCost(id);
    if (lc.status !== 'posted') conflict('stock.not_posted', 'Only posted landed costs can be voided');
    const date = opts.date ?? lc.date;
    ledger().assertPostingDate(date);
    db.tx(() => {
      const meta: PostMeta = { date, memo: `Void ${lc.number}`, reference: lc.number, sourceType: 'landed_cost', sourceId: id, userId };
      engine.operation(meta, () => {
        const diffs: Diff[] = [];
        const moveIds: number[] = [];
        for (const a of db.all<{ item_id: number; amount: number; to_inventory: number }>('SELECT * FROM landed_cost_allocations WHERE landed_cost_id = ?', [id])) {
          const item = catalog().item(a.item_id);
          const p = engine.pool(item.id);
          const back = p.qty > 0 ? -Math.min(a.to_inventory, p.value) : 0;
          const mv = engine.revalue({ itemId: item.id, value: back, date, sourceType: 'landed_cost', sourceId: id, userId });
          if (mv) moveIds.push(mv.id);
          diffs.push({ invAccount: inventoryAccount(item), counterAccount: lc.counter_account_id, amount: back });
          diffs.push({ invAccount: cogsAccount(item), counterAccount: lc.counter_account_id, amount: -a.amount - back });
        }
        const entry = postDifference(diffs, meta);
        linkEntry(moveIds, entry);
        db.run(`UPDATE landed_costs SET status = 'void', void_entry_id = ?, voided_at = ?, updated_at = ? WHERE id = ?`, [entry, nowIso(), nowIso(), id]);
      });
      audit().log({ userId, action: 'void', entity: 'landed_cost', entityId: id, summary: lc.number });
    });
  }

  // ------------------------------------------------------------ production
  /**
   * One production run as one inventory operation: components go out at their moving-average cost, the
   * finished product comes in at materials + conversion (labour and overhead applied, credited to the
   * given accounts). One balanced journal entry; nothing nets to the adjustment account on posting.
   */
  function produce(input: ProductionInput): ProductionResult {
    ledger().assertPostingDate(input.date);
    const output = catalog().item(input.output.itemId);
    if (!catalog().isStockItem(output)) fail('stock.not_stock_item', `${output.sku} is not a stock item`, { sku: output.sku });
    if (input.output.qty <= 0) fail('stock.invalid_qty', 'Invalid quantity');
    activeWarehouse(input.output.warehouseId);
    for (const c of input.components) activeWarehouse(c.warehouseId);
    const conversion = input.conversion.filter((c) => c.amount !== 0);
    if (conversion.some((c) => c.amount < 0 || !Number.isSafeInteger(c.amount))) fail('validation', 'Conversion costs cannot be negative');
    const meta: PostMeta = { date: input.date, memo: input.memo, reference: input.reference, sourceType: 'production', sourceId: input.sourceId, userId: input.userId };
    const adj = engine.adjustmentAccount();
    return engine.operation(meta, () => {
      const diffs: Diff[] = [];
      const moveIds: number[] = [];
      const componentValues: number[] = [];
      input.components.forEach((c, i) => {
        if (c.qty <= 0) return componentValues.push(0);
        const item = catalog().item(c.itemId);
        const lots = engine.parseLots(c.lots ?? null, 1000, i + 1);
        const parts = engine.allocateOut(item, c.warehouseId, c.qty, lots, { date: input.date, allowExpired: false, line: i + 1 });
        const moves = moveOut(parts, { date: input.date, itemId: item.id, warehouseId: c.warehouseId, sourceType: 'production', sourceId: input.sourceId, sourceLineId: c.lineId ?? null, userId: input.userId });
        let value = 0;
        for (const m of moves) {
          moveIds.push(m.id);
          value += -m.value;
          diffs.push({ invAccount: inventoryAccount(item), counterAccount: adj, amount: m.value });
        }
        componentValues.push(value);
      });
      const materials = componentValues.reduce((a, v) => a + v, 0);
      const conv = conversion.reduce((a, c) => a + c.amount, 0);
      const outLots = engine.parseLots(input.output.lots ?? null, 1000, 0);
      const parts = engine.allocateIn(output, input.output.qty, outLots, 0);
      const inMoves = moveIn(parts, materials + conv, { date: input.date, itemId: output.id, warehouseId: input.output.warehouseId, sourceType: 'production', sourceId: input.sourceId, userId: input.userId });
      for (const m of inMoves) {
        moveIds.push(m.id);
        diffs.push({ invAccount: inventoryAccount(output), counterAccount: adj, amount: m.value });
      }
      for (const c of conversion) diffs.push({ invAccount: c.accountId, counterAccount: adj, amount: -c.amount });
      const entry = postDifference(diffs, meta);
      linkEntry(moveIds, entry);
      return { entryId: entry, componentValues, materials, conversion: conv, outputValue: materials + conv };
    });
  }

  /**
   * Undo a production run: the product goes back out at its current average, the components come back
   * at the value they left with, the applied conversion is taken back. A product whose average moved
   * since leaves the difference on the inventory adjustment account.
   */
  function reverseProduction(sourceId: number, date: string, conversion: { accountId: number; amount: number }[], memo: string, reference: string | null, userId: number | null): number | null {
    ledger().assertPostingDate(date);
    const meta: PostMeta = { date, memo, reference, sourceType: 'production', sourceId, userId };
    const adj = engine.adjustmentAccount();
    return engine.operation(meta, () => {
      const moves = db.all<StockMove>("SELECT * FROM stock_moves WHERE source_type = 'production' AND source_id = ? AND is_reversal = 0 ORDER BY id DESC", [sourceId]);
      if (!moves.length) conflict('stock.not_posted', 'Nothing to reverse');
      const diffs: Diff[] = [];
      const moveIds: number[] = [];
      for (const m of moves) {
        const rev = reverseMove(m, date, userId)!;
        moveIds.push(rev.id);
        diffs.push({ invAccount: inventoryAccount(catalog().item(m.item_id)), counterAccount: adj, amount: rev.value });
      }
      for (const c of conversion) if (c.amount) diffs.push({ invAccount: c.accountId, counterAccount: adj, amount: c.amount });
      const entry = postDifference(diffs, meta);
      linkEntry(moveIds, entry);
      return entry;
    });
  }

  /** Current average cost of one unit (1000 base qty), or the purchase price when none is in stock. */
  function unitCost(itemId: number): number {
    return engine.averageValue(catalog().item(itemId), 1000);
  }

  // ------------------------------------------------------------ goods issues
  /**
   * A goods issue for another module (a sales delivery): every line leaves its warehouse at the
   * moving-average cost, one entry Dr cost of sales / Cr inventory.
   */
  function issue(input: IssueInput): IssueResult {
    ledger().assertPostingDate(input.date);
    const meta: PostMeta = { date: input.date, memo: input.memo, reference: input.reference, sourceType: input.sourceType, sourceId: input.sourceId, userId: input.userId };
    return engine.operation(meta, () => {
      const diffs: Diff[] = [];
      const moveIds: number[] = [];
      const values: number[] = [];
      input.lines.forEach((l, i) => {
        const item = catalog().item(l.itemId);
        if (!catalog().isStockItem(item)) return values.push(0);
        if (!Number.isSafeInteger(l.qty) || l.qty <= 0) fail('stock.invalid_qty', 'Invalid quantity');
        const wh = activeWarehouse(l.warehouseId).id;
        const lots = engine.parseLots(l.lots ?? null, 1000, i + 1);
        const parts = engine.allocateOut(item, wh, l.qty, lots, { date: input.date, allowExpired: false, line: i + 1 });
        const moves = moveOut(parts, { date: input.date, itemId: item.id, warehouseId: wh, sourceType: input.sourceType, sourceId: input.sourceId, sourceLineId: l.lineId, userId: input.userId });
        let value = 0;
        for (const m of moves) {
          moveIds.push(m.id);
          value += -m.value;
          diffs.push({ invAccount: inventoryAccount(item), counterAccount: cogsAccount(item), amount: m.value });
        }
        values.push(value);
      });
      const entryId = postDifference(diffs, meta);
      linkEntry(moveIds, entryId);
      return { entryId, values };
    });
  }

  // ------------------------------------------------------------ production recorded by manufacturing (GMES)
  /** Material consumed on a work order: it leaves its warehouse at the moving average; Dr work in progress / Cr inventory. */
  function wipIssue(input: WipMoveInput): number {
    ledger().assertPostingDate(input.date);
    const meta: PostMeta = { date: input.date, memo: input.memo, reference: input.reference, sourceType: 'mes_production', sourceId: input.sourceId, userId: null };
    return engine.operation(meta, () => {
      const item = catalog().item(input.itemId);
      if (!catalog().isStockItem(item)) return 0;
      const wh = activeWarehouse(input.warehouseId).id;
      const parts = engine.allocateOut(item, wh, input.qty, engine.parseLots(input.lots ?? null, 1000, 1), { date: input.date, allowExpired: false, line: 1 });
      const moves = moveOut(parts, { date: input.date, itemId: item.id, warehouseId: wh, sourceType: 'mes_production', sourceId: input.sourceId, sourceLineId: null, userId: null });
      const diffs: Diff[] = moves.map((m) => ({ invAccount: inventoryAccount(item), counterAccount: input.wipAccountId, amount: m.value }));
      linkEntry(moves.map((m) => m.id), postDifference(diffs, meta));
      return moves.reduce((a, m) => a - m.value, 0);
    });
  }

  /** Product completed on a work order: it enters its warehouse at the value taken out of work in progress; Dr inventory / Cr WIP. */
  function wipReceipt(input: WipMoveInput & { value: number }): void {
    ledger().assertPostingDate(input.date);
    if (!Number.isSafeInteger(input.value) || input.value < 0) fail('validation', 'Invalid production value');
    const meta: PostMeta = { date: input.date, memo: input.memo, reference: input.reference, sourceType: 'mes_production', sourceId: input.sourceId, userId: null };
    engine.operation(meta, () => {
      const item = catalog().item(input.itemId);
      if (!catalog().isStockItem(item)) fail('stock.not_stock_item', `${item.sku} is not a stock item`, { sku: item.sku });
      const wh = activeWarehouse(input.warehouseId).id;
      const parts = engine.allocateIn(item, input.qty, engine.parseLots(input.lots ?? null, 1000, 1), 1);
      const moves = moveIn(parts, input.value, { date: input.date, itemId: item.id, warehouseId: wh, sourceType: 'mes_production', sourceId: input.sourceId, userId: null });
      const diffs: Diff[] = moves.map((m) => ({ invAccount: inventoryAccount(item), counterAccount: input.wipAccountId, amount: m.value }));
      linkEntry(moves.map((m) => m.id), postDifference(diffs, meta));
    });
  }

  function reverseIssue(sourceType: string, sourceId: number, date: string, memo: string, reference: string | null, userId: number | null): number | null {
    ledger().assertPostingDate(date);
    const meta: PostMeta = { date, memo, reference, sourceType, sourceId, userId };
    return engine.operation(meta, () => {
      const moves = db.all<StockMove>('SELECT * FROM stock_moves WHERE source_type = ? AND source_id = ? AND is_reversal = 0 ORDER BY id DESC', [sourceType, sourceId]);
      const diffs: Diff[] = [];
      const moveIds: number[] = [];
      for (const m of moves) {
        const item = catalog().item(m.item_id);
        const rev = reverseMove(m, date, userId)!;
        moveIds.push(rev.id);
        diffs.push({ invAccount: inventoryAccount(item), counterAccount: cogsAccount(item), amount: rev.value });
      }
      const entry = postDifference(diffs, meta);
      linkEntry(moveIds, entry);
      return entry;
    });
  }

  function lineCosts(sourceType: string, sourceIds: number[]): LineCost[] {
    if (!sourceIds.length) return [];
    const out: LineCost[] = [];
    // Chunks keep the statement under SQLite's parameter limit.
    for (let i = 0; i < sourceIds.length; i += 500) {
      const chunk = sourceIds.slice(i, i + 500);
      out.push(
        ...db.all<LineCost>(
          `SELECT source_id AS sourceId, source_line_id AS sourceLineId, SUM(qty) AS qty, SUM(value) AS value FROM stock_moves
           WHERE source_type = ? AND source_id IN (${chunk.map(() => '?').join(',')}) AND source_line_id IS NOT NULL
           GROUP BY source_id, source_line_id`,
          [sourceType, ...chunk],
        ),
      );
    }
    return out;
  }

  const onHand = (itemId: number, warehouseId?: number | null) =>
    warehouseId ? engine.level(itemId, warehouseId) : db.get<{ q: number }>('SELECT COALESCE(SUM(qty), 0) q FROM stock_levels WHERE item_id = ?', [itemId])!.q;

  return {
    engine,
    produce,
    reverseProduction,
    unitCost,
    issue,
    wipIssue,
    wipReceipt,
    reverseIssue,
    lineCosts,
    onHand,
    registerReservations(fn: (itemId: number, warehouseId: number) => number) {
      reservedBy = fn;
    },
    warehouse,
    defaultWarehouse: engine.defaultWarehouse,
    level: engine.level,
    pool: engine.pool,
    hasMoves: (itemId: number) => !!db.get('SELECT 1 FROM stock_moves WHERE item_id = ? LIMIT 1', [itemId]),
    unitUsed: (unitId: number) =>
      !!db.get('SELECT 1 FROM stock_doc_lines WHERE unit_id = ? LIMIT 1', [unitId]) || !!db.get('SELECT 1 FROM goods_receipt_lines WHERE unit_id = ? LIMIT 1', [unitId]),
    purchaseLineAccount,
    onDocumentPosted,
    onDocumentVoided,
    stockDoc,
    docLines,
    createDoc: (input: StockDocInput, userId: number | null) => writeDoc(null, input, userId),
    updateDoc(id: number, input: StockDocInput, userId: number | null) {
      const d = stockDoc(id);
      if (d.status !== 'draft') conflict('stock.not_draft', 'Only drafts can be edited');
      if (d.kind !== input.kind) fail('stock.kind_locked', 'The document type cannot change');
      writeDoc(id, input, userId);
    },
    postDoc,
    voidDoc,
    removeDoc,
    receipt,
    receiptLines,
    createReceipt: (input: ReceiptInput, userId: number | null) => writeReceipt(null, input, userId),
    updateReceipt(id: number, input: ReceiptInput, userId: number | null) {
      if (receipt(id).status !== 'draft') conflict('stock.not_draft', 'Only drafts can be edited');
      writeReceipt(id, input, userId);
    },
    postReceipt,
    voidReceipt,
    removeReceipt(id: number, userId: number | null) {
      if (receipt(id).status !== 'draft') conflict('stock.not_draft', 'Only drafts can be deleted');
      db.tx(() => {
        db.run('DELETE FROM goods_receipts WHERE id = ?', [id]);
        audit().log({ userId, action: 'delete', entity: 'goods_receipt', entityId: id });
      });
    },
    landedCost,
    landedCostBasis,
    createLandedCost: (input: LandedCostInput, userId: number | null) => writeLandedCost(null, input, userId),
    updateLandedCost(id: number, input: LandedCostInput, userId: number | null) {
      if (landedCost(id).status !== 'draft') conflict('stock.not_draft', 'Only drafts can be edited');
      writeLandedCost(id, input, userId);
    },
    postLandedCost,
    voidLandedCost,
    removeLandedCost(id: number, userId: number | null) {
      if (landedCost(id).status !== 'draft') conflict('stock.not_draft', 'Only drafts can be deleted');
      db.tx(() => {
        db.run('DELETE FROM landed_costs WHERE id = ?', [id]);
        audit().log({ userId, action: 'delete', entity: 'landed_cost', entityId: id });
      });
    },
  };
}
