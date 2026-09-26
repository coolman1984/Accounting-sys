import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { divRound } from '../../kernel/money.js';
import type { JournalLineInput } from '../ledger/service.js';
import type { Item } from '../catalog/index.js';
import { KIND_INFO, type DocKind } from '../documents/schema.js';
import { STOCK_SEQ, type StockDocKind } from './schema.js';

export interface Warehouse {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  address: string | null;
  is_active: number;
  is_default: number;
}

export interface StockMove {
  id: number;
  date: string;
  item_id: number;
  warehouse_id: number;
  qty: number;
  value: number;
  source_type: string;
  source_id: number;
  source_line_id: number | null;
  is_reversal: number;
  qty_after: number;
  value_after: number;
  wh_qty_after: number;
  journal_entry_id: number | null;
}

export interface MoveInput {
  date: string;
  itemId: number;
  warehouseId: number;
  /** Signed quantity x1000: positive = in, negative = out. */
  qty: number;
  /** Value of an incoming move (required when qty > 0). Outgoing moves are always costed at average. */
  value?: number;
  sourceType: string;
  sourceId: number;
  sourceLineId?: number | null;
  isReversal?: boolean;
  userId: number | null;
}

export interface StockDocLineInput {
  itemId: number;
  qty: number;
  unitCost?: number | null;
  note?: string | null;
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
  unit_cost: number | null;
  system_qty: number | null;
  note: string | null;
}

const safe = (v: bigint) => Number(v);

export type InventoryService = ReturnType<typeof createInventory>;

/**
 * Perpetual inventory with a company-wide moving weighted average cost.
 *
 *  - Quantities are tracked per warehouse; value is pooled per item, so moving
 *    goods between warehouses never changes their cost.
 *  - Incoming moves carry their value (purchase price, return cost…); outgoing
 *    moves take value/qty of the pool. Taking the last unit takes the whole
 *    remaining value, so rounding never leaves "ghost" value behind.
 *  - After every stock operation the ledger is adjusted by exactly the
 *    difference between the change in stock value and what the source
 *    document already posted to inventory. Hence the inventory accounts
 *    always equal the stock valuation, to the piaster.
 */
export function createInventory({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const catalog = () => services.get('catalog');
  const audit = () => services.get('audit');

  // ------------------------------------------------------------- warehouses

  function warehouse(id: number): Warehouse {
    return db.get<Warehouse>('SELECT * FROM warehouses WHERE id = ?', [id]) ?? notFound('warehouse', id);
  }

  function defaultWarehouse(): number {
    const w =
      db.get<{ id: number }>('SELECT id FROM warehouses WHERE is_default = 1 AND is_active = 1') ??
      db.get<{ id: number }>('SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id LIMIT 1');
    return w?.id ?? fail('stock.no_warehouse', 'Create a warehouse first');
  }

  function activeWarehouse(id: number): Warehouse {
    const w = warehouse(id);
    if (!w.is_active) fail('stock.warehouse_inactive', `Warehouse ${w.code} is inactive`, { code: w.code });
    return w;
  }

  // ------------------------------------------------------------- the engine

  function pool(itemId: number) {
    return db.get<{ qty: number; value: number }>('SELECT qty, value FROM stock_values WHERE item_id = ?', [itemId]) ?? { qty: 0, value: 0 };
  }

  function level(itemId: number, warehouseId: number): number {
    return db.get<{ qty: number }>('SELECT qty FROM stock_levels WHERE item_id = ? AND warehouse_id = ?', [itemId, warehouseId])?.qty ?? 0;
  }

  /** Cost of `qty` units at the current average (fallback: the item's purchase price). */
  function averageValue(item: Item, qty: number): number {
    const p = pool(item.id);
    if (p.qty > 0) return safe(divRound(BigInt(p.value) * BigInt(qty), BigInt(p.qty)));
    return safe(divRound(BigInt(item.purchase_price) * BigInt(qty), 1000n));
  }

  function move(m: MoveInput): StockMove {
    const item = catalog().item(m.itemId);
    if (!catalog().isStockItem(item)) fail('stock.not_stock_item', `${item.sku} is not a stock item`, { sku: item.sku });
    if (!Number.isSafeInteger(m.qty) || m.qty === 0) fail('stock.invalid_qty', 'Invalid quantity');
    const p = pool(m.itemId);
    const onHand = level(m.itemId, m.warehouseId);
    let value: number;
    if (m.qty > 0) {
      if (m.value == null || !Number.isSafeInteger(m.value) || m.value < 0) fail('stock.invalid_value', 'Incoming stock needs a value');
      value = m.value!;
    } else {
      const out = -m.qty;
      if (out > onHand || out > p.qty) {
        const w = warehouse(m.warehouseId);
        fail('stock.insufficient', `Not enough ${item.sku} in ${w.code}: ${onHand / 1000} available`, {
          sku: item.sku,
          name: item.name_en,
          warehouse: w.code,
          available: onHand / 1000,
          requested: out / 1000,
        });
      }
      value = out === p.qty ? -p.value : -safe(divRound(BigInt(p.value) * BigInt(out), BigInt(p.qty)));
    }
    const qtyAfter = p.qty + m.qty;
    const valueAfter = p.value + value;
    db.run(
      `INSERT INTO stock_values (item_id, qty, value) VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET qty = excluded.qty, value = excluded.value`,
      [m.itemId, qtyAfter, valueAfter],
    );
    db.run(
      `INSERT INTO stock_levels (item_id, warehouse_id, qty) VALUES (?, ?, ?)
       ON CONFLICT(item_id, warehouse_id) DO UPDATE SET qty = excluded.qty`,
      [m.itemId, m.warehouseId, onHand + m.qty],
    );
    const id = db.insert('stock_moves', {
      date: m.date,
      item_id: m.itemId,
      warehouse_id: m.warehouseId,
      qty: m.qty,
      value,
      source_type: m.sourceType,
      source_id: m.sourceId,
      source_line_id: m.sourceLineId ?? null,
      is_reversal: !!m.isReversal,
      qty_after: qtyAfter,
      value_after: valueAfter,
      wh_qty_after: onHand + m.qty,
      created_by: m.userId,
      created_at: nowIso(),
    });
    return db.get<StockMove>('SELECT * FROM stock_moves WHERE id = ?', [id])!;
  }

  const inventoryAccount = (item: Item) => item.inventory_account_id ?? ledger().defaultAccount('inventory');
  const cogsAccount = (item: Item) => item.cogs_account_id ?? ledger().defaultAccount('cogs');
  const adjustmentAccount = () => {
    const d = ledger().defaultAccounts();
    return d.inventoryAdjustment ?? ledger().defaultAccount('cogs');
  };

  /**
   * Post the differences between stock value and ledger. `inv` = change needed
   * on each inventory account; each change is balanced against `counter`.
   */
  function postDifference(
    diffs: { invAccount: number; counterAccount: number; amount: number }[],
    meta: { date: string; memo: string; reference: string | null; sourceType: string; sourceId: number; userId: number | null },
  ): number | null {
    const byAcc = new Map<number, number>();
    const add = (acc: number, amt: number) => byAcc.set(acc, (byAcc.get(acc) ?? 0) + amt);
    for (const d of diffs) {
      if (d.amount === 0) continue;
      add(d.invAccount, d.amount); // debit-positive
      add(d.counterAccount, -d.amount);
    }
    const lines: JournalLineInput[] = [];
    for (const [acc, amt] of byAcc) {
      if (amt > 0) lines.push({ accountId: acc, debit: amt, credit: 0 });
      else if (amt < 0) lines.push({ accountId: acc, debit: 0, credit: -amt });
    }
    if (lines.length < 2) return null;
    return ledger().createEntry(
      { date: meta.date, memo: meta.memo, reference: meta.reference, lines },
      { sourceType: meta.sourceType, sourceId: meta.sourceId, userId: meta.userId },
    );
  }

  function linkEntry(moveIds: number[], entryId: number | null) {
    if (!entryId || !moveIds.length) return;
    db.run(`UPDATE stock_moves SET journal_entry_id = ? WHERE id IN (${moveIds.map(() => '?').join(',')})`, [entryId, ...moveIds]);
  }

  // ------------------------------------------------- sales & purchase documents

  /** What the document itself posted to the item's inventory account for a line (debit-positive). */
  function ledgerEffect(kind: DocKind, net: number): number {
    if (kind === 'purchase_bill') return net;
    if (kind === 'purchase_credit') return -net;
    return 0; // sales documents never touch inventory in their own entry
  }

  function onDocumentPosted(documentId: number, userId: number | null): void {
    const docs = services.get('documents');
    const doc = docs.get(documentId);
    const lines = docs.lines(documentId);
    const info = KIND_INFO[doc.kind];
    const stockLines = lines
      .map((l) => ({ l, item: l.item_id ? catalog().item(l.item_id) : null }))
      .filter((x): x is { l: (typeof lines)[number]; item: Item } => !!x.item && catalog().isStockItem(x.item));
    if (stockLines.length === 0) return;

    const headerWh = doc.warehouse_id ?? defaultWarehouse();
    // Returns against an invoice come back at the cost they left at.
    const returnCost = new Map<number, { qty: number; value: number }>();
    if (doc.kind === 'sales_credit' && doc.against_document_id) {
      for (const r of db.all<{ item_id: number; qty: number; value: number }>(
        `SELECT item_id, -SUM(qty) qty, -SUM(value) value FROM stock_moves
         WHERE source_type = 'sales_invoice' AND source_id = ? GROUP BY item_id`,
        [doc.against_document_id],
      )) {
        if (r.qty > 0) returnCost.set(r.item_id, r);
      }
    }

    const diffs: { invAccount: number; counterAccount: number; amount: number }[] = [];
    const moveIds: number[] = [];
    for (const { l, item } of stockLines) {
      const wh = activeWarehouse(l.warehouse_id ?? headerWh).id;
      const invAcc = inventoryAccount(item);
      if (info.side === 'purchases' && l.account_id !== invAcc) {
        fail('stock.line_account', `Line ${l.line_no}: stock item ${item.sku} must be booked to its inventory account`, {
          line: l.line_no,
          sku: item.sku,
        });
      }
      let mv: StockMove;
      if (doc.kind === 'purchase_bill') {
        mv = move({ date: doc.date, itemId: item.id, warehouseId: wh, qty: l.quantity, value: l.net, sourceType: doc.kind, sourceId: doc.id, sourceLineId: l.id, userId });
      } else if (doc.kind === 'sales_credit') {
        const orig = returnCost.get(item.id);
        const value = orig
          ? safe(divRound(BigInt(orig.value) * BigInt(l.quantity), BigInt(orig.qty)))
          : averageValue(item, l.quantity);
        mv = move({ date: doc.date, itemId: item.id, warehouseId: wh, qty: l.quantity, value, sourceType: doc.kind, sourceId: doc.id, sourceLineId: l.id, userId });
      } else {
        // sales_invoice & purchase_credit: goods leave at average cost
        mv = move({ date: doc.date, itemId: item.id, warehouseId: wh, qty: -l.quantity, sourceType: doc.kind, sourceId: doc.id, sourceLineId: l.id, userId });
      }
      moveIds.push(mv.id);
      diffs.push({ invAccount: invAcc, counterAccount: cogsAccount(item), amount: mv.value - ledgerEffect(doc.kind, l.net) });
    }
    const entry = postDifference(diffs, {
      date: doc.date,
      memo: `${doc.number} — cost of goods`,
      reference: doc.number,
      sourceType: 'cogs',
      sourceId: doc.id,
      userId,
    });
    linkEntry(moveIds, entry);
  }

  function onDocumentVoided(documentId: number, date: string, userId: number | null): void {
    const docs = services.get('documents');
    const doc = docs.get(documentId);
    const moves = db.all<StockMove>('SELECT * FROM stock_moves WHERE source_type = ? AND source_id = ? AND is_reversal = 0 ORDER BY id DESC', [doc.kind, doc.id]);
    if (!moves.length) return;
    const lineNet = new Map(docs.lines(doc.id).map((l) => [l.id, l.net]));
    const diffs: { invAccount: number; counterAccount: number; amount: number }[] = [];
    const moveIds: number[] = [];
    for (const m of moves) {
      const item = catalog().item(m.item_id);
      const rev = reverseMove(m, date, userId);
      moveIds.push(rev.id);
      // The document's own reversal undoes its inventory effect; true up the rest.
      const ledgerReversal = -ledgerEffect(doc.kind, lineNet.get(m.source_line_id ?? 0) ?? 0);
      diffs.push({ invAccount: inventoryAccount(item), counterAccount: cogsAccount(item), amount: rev.value - ledgerReversal });
    }
    const entry = postDifference(diffs, {
      date,
      memo: `Void ${doc.number} — cost of goods`,
      reference: doc.number,
      sourceType: 'cogs',
      sourceId: doc.id,
      userId,
    });
    linkEntry(moveIds, entry);
  }

  /** Undo a movement: goods that came in go out at average cost; goods that went out come back at their value. */
  function reverseMove(m: StockMove, date: string, userId: number | null): StockMove {
    return m.qty > 0
      ? move({ date, itemId: m.item_id, warehouseId: m.warehouse_id, qty: -m.qty, sourceType: m.source_type, sourceId: m.source_id, sourceLineId: m.source_line_id, isReversal: true, userId })
      : move({ date, itemId: m.item_id, warehouseId: m.warehouse_id, qty: -m.qty, value: -m.value, sourceType: m.source_type, sourceId: m.source_id, sourceLineId: m.source_line_id, isReversal: true, userId });
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
      input.lines.forEach((l, i) =>
        db.insert('stock_doc_lines', { doc_id: docId, line_no: i + 1, item_id: l.itemId, qty: l.qty, unit_cost: l.unitCost ?? null, note: l.note ?? null }),
      );
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'stock_document', entityId: docId, summary: input.kind });
      return docId;
    });
  }

  function counterFor(doc: StockDoc): number {
    if (doc.counter_account_id) return doc.counter_account_id;
    return doc.kind === 'opening' ? ledger().defaultAccount('capital') : adjustmentAccount();
  }

  function incomingValue(item: Item, qty: number, unitCost: number | null): number {
    return unitCost != null ? safe(divRound(BigInt(qty) * BigInt(unitCost), 1000n)) : averageValue(item, qty);
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
      lines: lines.map((l) => ({ itemId: l.item_id, qty: l.qty, unitCost: l.unit_cost })),
    });
    ledger().assertPostingDate(doc.date);
    db.tx(() => {
      const number = services.get('sequences').next(STOCK_SEQ[doc.kind][0]);
      db.run(`UPDATE stock_docs SET number = ?, updated_at = ? WHERE id = ?`, [number, nowIso(), id]);
      const counter = doc.kind === 'transfer' ? 0 : counterFor(doc);
      const diffs: { invAccount: number; counterAccount: number; amount: number }[] = [];
      const moveIds: number[] = [];
      const base = { date: doc.date, sourceType: doc.kind, sourceId: doc.id, userId };
      for (const l of lines) {
        const item = catalog().item(l.item_id);
        let delta = l.qty;
        if (doc.kind === 'count') {
          const book = level(item.id, doc.warehouse_id);
          db.run('UPDATE stock_doc_lines SET system_qty = ? WHERE id = ?', [book, l.id]);
          delta = l.qty - book;
        }
        if (doc.kind === 'transfer') {
          const out = move({ ...base, itemId: item.id, warehouseId: doc.warehouse_id, qty: -l.qty, sourceLineId: l.id });
          const inn = move({ ...base, itemId: item.id, warehouseId: doc.to_warehouse_id!, qty: l.qty, value: -out.value, sourceLineId: l.id });
          moveIds.push(out.id, inn.id);
          continue;
        }
        if (delta === 0) continue;
        const mv =
          delta > 0
            ? move({ ...base, itemId: item.id, warehouseId: doc.warehouse_id, qty: delta, value: incomingValue(item, delta, l.unit_cost), sourceLineId: l.id })
            : move({ ...base, itemId: item.id, warehouseId: doc.warehouse_id, qty: delta, sourceLineId: l.id });
        moveIds.push(mv.id);
        diffs.push({ invAccount: inventoryAccount(item), counterAccount: counter, amount: mv.value });
      }
      const entry = postDifference(diffs, {
        date: doc.date,
        memo: doc.memo ?? number,
        reference: number,
        sourceType: `stock_${doc.kind}`,
        sourceId: doc.id,
        userId,
      });
      linkEntry(moveIds, entry);
      db.run(`UPDATE stock_docs SET status = 'posted', journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE id = ?`, [entry, nowIso(), nowIso(), id]);
      audit().log({ userId, action: 'post', entity: 'stock_document', entityId: id, summary: number });
    });
  }

  function voidDoc(id: number, opts: { date?: string | null }, userId: number | null): void {
    const doc = stockDoc(id);
    if (doc.status !== 'posted') conflict('stock.not_posted', 'Only posted documents can be voided');
    const date = opts.date ?? doc.date;
    ledger().assertPostingDate(date);
    db.tx(() => {
      const moves = db.all<StockMove>('SELECT * FROM stock_moves WHERE source_type = ? AND source_id = ? AND is_reversal = 0 ORDER BY id DESC', [doc.kind, doc.id]);
      const counter = doc.kind === 'transfer' ? adjustmentAccount() : counterFor(doc);
      const diffs: { invAccount: number; counterAccount: number; amount: number }[] = [];
      const moveIds: number[] = [];
      for (const m of moves) {
        const rev = reverseMove(m, date, userId);
        moveIds.push(rev.id);
        diffs.push({ invAccount: inventoryAccount(catalog().item(m.item_id)), counterAccount: counter, amount: rev.value });
      }
      const entry = postDifference(diffs, {
        date,
        memo: `Void ${doc.number}`,
        reference: doc.number,
        sourceType: `stock_${doc.kind}`,
        sourceId: doc.id,
        userId,
      });
      linkEntry(moveIds, entry);
      db.run(`UPDATE stock_docs SET status = 'void', void_entry_id = ?, voided_at = ?, updated_at = ? WHERE id = ?`, [entry, nowIso(), nowIso(), id]);
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

  return {
    warehouse,
    defaultWarehouse,
    level,
    pool,
    averageValue,
    move,
    hasMoves: (itemId: number) => !!db.get('SELECT 1 FROM stock_moves WHERE item_id = ? LIMIT 1', [itemId]),
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
  };
}
