import type { ModuleContext } from '../../kernel/modules.js';
import { fail, notFound } from '../../kernel/errors.js';
import { isValidDate, nowIso } from '../../kernel/dates.js';
import { divRound } from '../../kernel/money.js';
import type { JournalLineInput } from '../ledger/service.js';
import type { Item } from '../catalog/index.js';

export interface StockMove {
  id: number;
  date: string;
  item_id: number;
  warehouse_id: number;
  lot_id: number | null;
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
  /** Signed base quantity x1000: positive = in, negative = out. */
  qty: number;
  /** Value of an incoming move (required when qty > 0). Outgoing moves are always costed at average. */
  value?: number;
  lotId?: number | null;
  sourceType: string;
  sourceId: number;
  sourceLineId?: number | null;
  isReversal?: boolean;
  userId: number | null;
}

/** A lot request as typed by the user: quantities are in the line's unit. */
export interface LotRequest {
  lotNo: string;
  expiry?: string | null;
  qty: number;
}

export interface LotPart {
  lotId: number | null;
  qty: number; // base x1000
}

export interface Diff {
  /** Account that gets the (debit-positive) amount … */
  invAccount: number;
  /** … balanced against this one. */
  counterAccount: number;
  amount: number;
}

export interface PostMeta {
  date: string;
  memo: string;
  reference: string | null;
  sourceType: string;
  sourceId: number;
  userId: number | null;
}

const big = (n: number) => BigInt(n);
export const mulDiv = (a: number, b: number, c: number) => Number(divRound(big(a) * big(b), big(c)));

/** Split `total` across `weights` proportionally, the last part taking the rounding remainder. */
export function split(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((s, w) => s + w, 0);
  if (sumW === 0) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  let used = 0;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return total - used;
    const part = mulDiv(total, w, sumW);
    used += part;
    return part;
  });
}

/**
 * The costing engine: stock levels per warehouse and lot, a company-wide
 * moving-average cost pool per item, and the immutable stock ledger.
 *
 * Every public operation of the inventory module runs inside `operation()`,
 * which remembers which items it touched. If any of those movements was dated
 * before existing ones (a back-dated entry), the item is re-costed: its
 * history is replayed in date order and the value difference is booked as a
 * revaluation (stock ledger + journal), so costs stay right and the books keep
 * matching the stock valuation.
 */
export function createEngine({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const catalog = () => services.get('catalog');

  // ------------------------------------------------------------------ reads
  const pool = (itemId: number) =>
    db.get<{ qty: number; value: number }>('SELECT qty, value FROM stock_values WHERE item_id = ?', [itemId]) ?? { qty: 0, value: 0 };
  const level = (itemId: number, warehouseId: number) =>
    db.get<{ qty: number }>('SELECT qty FROM stock_levels WHERE item_id = ? AND warehouse_id = ?', [itemId, warehouseId])?.qty ?? 0;
  const lotLevel = (lotId: number, warehouseId: number) =>
    db.get<{ qty: number }>('SELECT qty FROM lot_levels WHERE lot_id = ? AND warehouse_id = ?', [lotId, warehouseId])?.qty ?? 0;
  const warehouseCode = (id: number) => db.get<{ code: string }>('SELECT code FROM warehouses WHERE id = ?', [id])?.code ?? String(id);

  function defaultWarehouse(): number {
    const w =
      db.get<{ id: number }>('SELECT id FROM warehouses WHERE is_default = 1 AND is_active = 1') ??
      db.get<{ id: number }>('SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id LIMIT 1');
    return w?.id ?? fail('stock.no_warehouse', 'Create a warehouse first');
  }

  /** Cost of `qty` base units at the current average (fallback: the item's purchase price). */
  function averageValue(item: Item, qty: number): number {
    const p = pool(item.id);
    if (p.qty > 0) return mulDiv(p.value, qty, p.qty);
    return mulDiv(item.purchase_price, qty, 1000);
  }

  // ------------------------------------------------------------ operations
  interface Op {
    touched: Map<number, { minDate: string; firstId: number }>;
    meta: PostMeta | null;
  }
  let current: Op | null = null;

  /**
   * Run `fn` as one inventory operation (always inside the caller's DB
   * transaction). Nested calls join the outer operation.
   */
  function operation<T>(meta: PostMeta, fn: () => T): T {
    if (current) return fn();
    current = { touched: new Map(), meta };
    try {
      const out = fn();
      const op = current;
      current = null;
      for (const [itemId, t] of op.touched) {
        const older = db.get('SELECT 1 FROM stock_moves WHERE item_id = ? AND id < ? AND date > ? LIMIT 1', [itemId, t.firstId, t.minDate]);
        if (older) recost(itemId, meta);
      }
      return out;
    } finally {
      current = null;
    }
  }

  // --------------------------------------------------------------- the move
  function insufficient(item: Item, warehouseId: number, available: number, requested: number, extra: Record<string, unknown> = {}): never {
    const code = warehouseCode(warehouseId);
    return fail('stock.insufficient', `Not enough ${item.sku} in ${code}: ${available / 1000} available`, {
      sku: item.sku,
      name: item.name_en,
      warehouse: code,
      available: available / 1000,
      requested: requested / 1000,
      ...extra,
    });
  }

  /**
   * A back-dated outgoing move must not push the warehouse negative at any
   * point after its date (e.g. selling on the 5th goods that arrived on the 10th).
   */
  function checkHistory(item: Item, warehouseId: number, date: string, out: number): void {
    const later = db.get('SELECT 1 FROM stock_moves WHERE item_id = ? AND warehouse_id = ? AND date > ? LIMIT 1', [item.id, warehouseId, date]);
    if (!later) return;
    const rows = db.all<{ date: string; q: number }>(
      'SELECT date, SUM(qty) q FROM stock_moves WHERE item_id = ? AND warehouse_id = ? GROUP BY date ORDER BY date',
      [item.id, warehouseId],
    );
    // Balance on the move's own date, then after every later date: none may drop below the quantity taken.
    const onDate = rows.filter((r) => r.date <= date).reduce((s, r) => s + r.q, 0);
    let running = onDate;
    let lowest = onDate;
    for (const r of rows) {
      if (r.date <= date) continue;
      running += r.q;
      lowest = Math.min(lowest, running);
    }
    if (lowest - out < 0) insufficient(item, warehouseId, Math.max(0, lowest), out, { asOf: date });
  }

  function move(m: MoveInput): StockMove {
    const item = catalog().item(m.itemId);
    if (!catalog().isStockItem(item)) fail('stock.not_stock_item', `${item.sku} is not a stock item`, { sku: item.sku });
    if (!Number.isSafeInteger(m.qty) || m.qty === 0) fail('stock.invalid_qty', 'Invalid quantity');
    if (!isValidDate(m.date)) fail('validation', 'Invalid date');
    if (item.tracking !== 'none' && !m.lotId) fail('stock.lot_required', `${item.sku} needs a lot / serial number`, { sku: item.sku });
    const p = pool(m.itemId);
    const onHand = level(m.itemId, m.warehouseId);
    let value: number;
    if (m.qty > 0) {
      if (m.value == null || !Number.isSafeInteger(m.value) || m.value < 0) fail('stock.invalid_value', 'Incoming stock needs a value');
      value = m.value!;
      if (item.tracking === 'serial' && m.lotId) {
        const inStock = db.get<{ q: number }>('SELECT COALESCE(SUM(qty), 0) q FROM lot_levels WHERE lot_id = ?', [m.lotId])!.q;
        if (inStock + m.qty > 1000) {
          const lot = db.get<{ lot_no: string }>('SELECT lot_no FROM stock_lots WHERE id = ?', [m.lotId])!;
          fail('stock.serial_in_stock', `Serial ${lot.lot_no} of ${item.sku} is already in stock`, { sku: item.sku, serial: lot.lot_no });
        }
      }
    } else {
      const out = -m.qty;
      if (out > onHand || out > p.qty) insufficient(item, m.warehouseId, onHand, out);
      if (m.lotId) {
        const lq = lotLevel(m.lotId, m.warehouseId);
        if (out > lq) {
          const lot = db.get<{ lot_no: string }>('SELECT lot_no FROM stock_lots WHERE id = ?', [m.lotId])!;
          insufficient(item, m.warehouseId, lq, out, { lot: lot.lot_no });
        }
      }
      checkHistory(item, m.warehouseId, m.date, out);
      value = out === p.qty ? -p.value : -mulDiv(p.value, out, p.qty);
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
    if (m.lotId) {
      db.run(
        `INSERT INTO lot_levels (lot_id, warehouse_id, qty) VALUES (?, ?, ?)
         ON CONFLICT(lot_id, warehouse_id) DO UPDATE SET qty = excluded.qty`,
        [m.lotId, m.warehouseId, lotLevel(m.lotId, m.warehouseId) + m.qty],
      );
    }
    const id = db.insert('stock_moves', {
      date: m.date,
      item_id: m.itemId,
      warehouse_id: m.warehouseId,
      lot_id: m.lotId ?? null,
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
    touch(m.itemId, m.date, id);
    return db.get<StockMove>('SELECT * FROM stock_moves WHERE id = ?', [id])!;
  }

  function touch(itemId: number, date: string, id: number) {
    if (!current) return;
    const t = current.touched.get(itemId);
    if (!t) current.touched.set(itemId, { minDate: date, firstId: id });
    else if (date < t.minDate) t.minDate = date;
  }

  /**
   * Value-only move (no quantity): landed costs, price differences, revaluations.
   * The pool must hold stock to carry a value.
   */
  function revalue(m: { itemId: number; value: number; date: string; sourceType: string; sourceId: number; sourceLineId?: number | null; userId: number | null }): StockMove | null {
    if (m.value === 0) return null;
    const p = pool(m.itemId);
    if (p.qty <= 0) fail('stock.revalue_empty', 'Cannot change the value of an item with no stock');
    if (p.value + m.value < 0) fail('stock.revalue_negative', 'Stock value cannot become negative');
    const wh = defaultWarehouse();
    db.run('UPDATE stock_values SET value = value + ? WHERE item_id = ?', [m.value, m.itemId]);
    const id = db.insert('stock_moves', {
      date: m.date,
      item_id: m.itemId,
      warehouse_id: wh,
      lot_id: null,
      qty: 0,
      value: m.value,
      source_type: m.sourceType,
      source_id: m.sourceId,
      source_line_id: m.sourceLineId ?? null,
      is_reversal: false,
      qty_after: p.qty,
      value_after: p.value + m.value,
      wh_qty_after: level(m.itemId, wh),
      created_by: m.userId,
      created_at: nowIso(),
    });
    return db.get<StockMove>('SELECT * FROM stock_moves WHERE id = ?', [id])!;
  }

  // ---------------------------------------------------------------- recost
  /**
   * Replay an item's history in date order under moving-average rules and book
   * the difference between the ideal value and the current one. Transfers are
   * value-neutral and skipped; value-only moves keep their position in posting
   * order (they were computed against the stock on hand at that moment).
   */
  function recost(itemId: number, meta: PostMeta): void {
    const moves = db.all<StockMove>("SELECT * FROM stock_moves WHERE item_id = ? AND source_type NOT IN ('transfer', 'revaluation') ORDER BY id", [itemId]);
    let maxDate = '';
    const keyed = moves.map((m) => {
      maxDate = m.date > maxDate ? m.date : maxDate;
      return { m, eff: m.qty === 0 ? maxDate : m.date };
    });
    keyed.sort((a, b) => (a.eff < b.eff ? -1 : a.eff > b.eff ? 1 : a.m.id - b.m.id));
    let q = 0;
    let v = 0;
    for (const { m } of keyed) {
      if (m.qty > 0) {
        q += m.qty;
        v += m.value;
      } else if (m.qty < 0) {
        const out = Math.min(-m.qty, q);
        const cost = out >= q ? v : mulDiv(v, out, q);
        q -= out;
        v -= cost;
      } else v += m.value;
      if (q <= 0) {
        q = 0;
        v = 0;
      }
      if (v < 0) v = 0;
    }
    const p = pool(itemId);
    if (p.qty !== q) return; // histories disagree on quantity (should not happen) — leave values untouched
    const correction = v - p.value;
    if (correction === 0) return;
    const item = catalog().item(itemId);
    const mv = revalue({ itemId, value: correction, date: meta.date, sourceType: 'revaluation', sourceId: meta.sourceId, userId: meta.userId });
    const entry = postDifference([{ invAccount: inventoryAccount(item), counterAccount: cogsAccount(item), amount: correction }], {
      ...meta,
      memo: `Cost revaluation ${item.sku} (back-dated entry)`,
      sourceType: 'stock_revaluation',
    });
    if (mv) linkEntry([mv.id], entry);
  }

  // -------------------------------------------------------------- accounts
  const inventoryAccount = (item: Item) => item.inventory_account_id ?? ledger().defaultAccount('inventory');
  const cogsAccount = (item: Item) => item.cogs_account_id ?? ledger().defaultAccount('cogs');
  const adjustmentAccount = () => ledger().defaultAccounts().inventoryAdjustment ?? ledger().defaultAccount('cogs');

  /** The "goods received not invoiced" clearing account, created on first use for older companies. */
  function grniAccount(): number {
    const d = ledger().defaultAccounts().grni;
    if (d) return d;
    const payable = ledger().account(ledger().defaultAccount('payable'));
    let code = '2160';
    while (ledger().accountByCode(code)) code = code + '1';
    const id = ledger().createAccount(
      {
        code,
        nameEn: 'Goods Received Not Invoiced',
        nameAr: 'بضاعة مستلمة لم تصل فواتيرها',
        type: 'liability',
        subtype: 'current_liability',
        parentId: payable.parent_id,
        isGroup: false,
        isActive: true,
        description: null,
      },
      null,
    );
    ledger().setDefaultAccounts({ grni: id }, null);
    return id;
  }

  /** Book `diffs` as one balanced journal entry (nothing if everything nets to zero). */
  function postDifference(diffs: Diff[], meta: PostMeta): number | null {
    const byAcc = new Map<number, number>();
    const add = (acc: number, amt: number) => byAcc.set(acc, (byAcc.get(acc) ?? 0) + amt);
    for (const d of diffs) {
      if (d.amount === 0) continue;
      add(d.invAccount, d.amount);
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
    db.run(`UPDATE stock_moves SET journal_entry_id = ? WHERE id IN (${moveIds.map(() => '?').join(',')}) AND journal_entry_id IS NULL`, [
      entryId,
      ...moveIds,
    ]);
  }

  // ------------------------------------------------------------------- lots
  /** Validate the lots typed on a line and convert their quantities to base units. */
  function parseLots(raw: unknown, factor: number, line: number): { lotNo: string; expiry: string | null; qty: number }[] {
    if (raw == null) return [];
    if (!Array.isArray(raw)) return fail('stock.lots_invalid', `Line ${line}: invalid lots`, { line });
    return raw.map((r: any) => {
      const lotNo = typeof r?.lotNo === 'string' ? r.lotNo.trim() : '';
      const expiry = r?.expiry ? String(r.expiry) : null;
      const qty = Number(r?.qty);
      if (!lotNo || lotNo.length > 64) fail('stock.lots_invalid', `Line ${line}: lot / serial number is missing`, { line });
      if (expiry && !isValidDate(expiry)) fail('stock.lots_invalid', `Line ${line}: invalid expiry date`, { line });
      if (!Number.isSafeInteger(qty) || qty <= 0) fail('stock.lots_invalid', `Line ${line}: invalid lot quantity`, { line });
      return { lotNo, expiry, qty: mulDiv(qty, factor, 1000) };
    });
  }

  function findLot(itemId: number, lotNo: string) {
    return db.get<{ id: number; lot_no: string; expiry_date: string | null }>('SELECT * FROM stock_lots WHERE item_id = ? AND lot_no = ?', [itemId, lotNo]);
  }

  function ensureLot(item: Item, lotNo: string, expiry: string | null, line: number): number {
    const lot = findLot(item.id, lotNo);
    if (lot) {
      if (expiry && lot.expiry_date && lot.expiry_date !== expiry) {
        fail('stock.lot_expiry_mismatch', `Line ${line}: lot ${lotNo} already exists with expiry ${lot.expiry_date}`, { line, lot: lotNo, expiry: lot.expiry_date });
      }
      if (expiry && !lot.expiry_date) db.run('UPDATE stock_lots SET expiry_date = ? WHERE id = ?', [expiry, lot.id]);
      if (item.requires_expiry && !expiry && !lot.expiry_date) fail('stock.expiry_required', `Line ${line}: ${item.sku} needs an expiry date`, { line, sku: item.sku });
      return lot.id;
    }
    if (item.requires_expiry && !expiry) fail('stock.expiry_required', `Line ${line}: ${item.sku} needs an expiry date`, { line, sku: item.sku });
    return db.insert('stock_lots', { item_id: item.id, lot_no: lotNo, expiry_date: expiry, created_at: nowIso() });
  }

  /** Incoming goods: which lots they belong to (tracked items must say so). */
  function allocateIn(item: Item, baseQty: number, requested: { lotNo: string; expiry: string | null; qty: number }[], line: number): LotPart[] {
    if (item.tracking === 'none') return [{ lotId: null, qty: baseQty }];
    if (!requested.length) fail('stock.lot_required', `Line ${line}: enter the ${item.tracking === 'serial' ? 'serial numbers' : 'lot numbers'} for ${item.sku}`, { line, sku: item.sku });
    const total = requested.reduce((s, r) => s + r.qty, 0);
    if (total !== baseQty) fail('stock.lot_qty_mismatch', `Line ${line}: lot quantities (${total / 1000}) must add up to ${baseQty / 1000}`, { line, lots: total / 1000, qty: baseQty / 1000 });
    if (item.tracking === 'serial') {
      const seen = new Set<string>();
      for (const r of requested) {
        if (r.qty !== 1000) fail('stock.serial_qty', `Line ${line}: each serial number is exactly one unit`, { line });
        if (seen.has(r.lotNo)) fail('stock.serial_duplicate', `Line ${line}: serial ${r.lotNo} is listed twice`, { line, serial: r.lotNo });
        seen.add(r.lotNo);
      }
    }
    return requested.map((r) => ({ lotId: ensureLot(item, r.lotNo, r.expiry, line), qty: r.qty }));
  }

  /**
   * Outgoing goods: the lots named on the line, or automatically the ones that
   * expire first (FEFO; serials first-in-first-out). Expired lots are never
   * picked automatically and cannot be sold.
   */
  function allocateOut(
    item: Item,
    warehouseId: number,
    baseQty: number,
    requested: { lotNo: string; qty: number }[],
    o: { date: string; allowExpired: boolean; line: number },
  ): LotPart[] {
    if (item.tracking === 'none') return [{ lotId: null, qty: baseQty }];
    if (requested.length) {
      const total = requested.reduce((s, r) => s + r.qty, 0);
      if (total !== baseQty) fail('stock.lot_qty_mismatch', `Line ${o.line}: lot quantities (${total / 1000}) must add up to ${baseQty / 1000}`, { line: o.line, lots: total / 1000, qty: baseQty / 1000 });
      return requested.map((r) => {
        const lot = findLot(item.id, r.lotNo);
        if (!lot) return fail('stock.lot_unknown', `Line ${o.line}: ${item.sku} has no lot ${r.lotNo}`, { line: o.line, sku: item.sku, lot: r.lotNo });
        if (!o.allowExpired && lot.expiry_date && lot.expiry_date < o.date) {
          fail('stock.lot_expired', `Line ${o.line}: lot ${r.lotNo} expired on ${lot.expiry_date}`, { line: o.line, lot: r.lotNo, expiry: lot.expiry_date });
        }
        const avail = lotLevel(lot.id, warehouseId);
        if (r.qty > avail) insufficient(item, warehouseId, avail, r.qty, { lot: r.lotNo });
        return { lotId: lot.id, qty: r.qty };
      });
    }
    const lots = db.all<{ id: number; expiry_date: string | null; qty: number }>(
      `SELECT l.id, l.expiry_date, ll.qty FROM lot_levels ll JOIN stock_lots l ON l.id = ll.lot_id
       WHERE l.item_id = ? AND ll.warehouse_id = ? AND ll.qty > 0
       ORDER BY (l.expiry_date IS NULL), l.expiry_date, l.id`,
      [item.id, warehouseId],
    );
    const parts: LotPart[] = [];
    let left = baseQty;
    let expired = 0;
    for (const l of lots) {
      if (left <= 0) break;
      if (!o.allowExpired && l.expiry_date && l.expiry_date < o.date) {
        expired += l.qty;
        continue;
      }
      const take = Math.min(left, l.qty);
      parts.push({ lotId: l.id, qty: take });
      left -= take;
    }
    if (left > 0) insufficient(item, warehouseId, baseQty - left, baseQty, expired ? { expired: expired / 1000 } : {});
    return parts;
  }

  /** Move `baseQty` in across lots, splitting `value` proportionally. */
  function moveIn(parts: LotPart[], value: number, m: Omit<MoveInput, 'qty' | 'value' | 'lotId'>): StockMove[] {
    const values = split(value, parts.map((p) => p.qty));
    return parts.map((p, i) => move({ ...m, qty: p.qty, value: values[i], lotId: p.lotId }));
  }

  function moveOut(parts: LotPart[], m: Omit<MoveInput, 'qty' | 'value' | 'lotId'>): StockMove[] {
    return parts.map((p) => move({ ...m, qty: -p.qty, lotId: p.lotId }));
  }

  /** Undo a movement: goods that came in go out at average cost; goods that went out come back at their value. */
  function reverseMove(m: StockMove, date: string, userId: number | null): StockMove | null {
    const base = { date, itemId: m.item_id, warehouseId: m.warehouse_id, lotId: m.lot_id, sourceType: m.source_type, sourceId: m.source_id, sourceLineId: m.source_line_id, isReversal: true, userId };
    if (m.qty > 0) return move({ ...base, qty: -m.qty });
    if (m.qty < 0) return move({ ...base, qty: -m.qty, value: -m.value });
    // value-only: take the value back out, as far as the pool still holds it
    const p = pool(m.item_id);
    const back = p.qty > 0 ? Math.max(-p.value, -m.value) : 0;
    return revalue({ itemId: m.item_id, value: back, date, sourceType: m.source_type, sourceId: m.source_id, sourceLineId: m.source_line_id, userId });
  }

  return {
    pool,
    level,
    lotLevel,
    defaultWarehouse,
    averageValue,
    operation,
    move,
    revalue,
    recost,
    moveIn,
    moveOut,
    reverseMove,
    parseLots,
    findLot,
    allocateIn,
    allocateOut,
    inventoryAccount,
    cogsAccount,
    adjustmentAccount,
    grniAccount,
    postDifference,
    linkEntry,
    item: (id: number) => catalog().item(id) ?? notFound('item', id),
  };
}

export type Engine = ReturnType<typeof createEngine>;
