import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { addDays, nowIso, today } from '../../kernel/dates.js';
import { computeLine, divRound, fxToBase, sum } from '../../kernel/money.js';
import type {} from '../../contracts/fx.js';
import type {} from '../../contracts/pricing.js';
import type {} from '../../contracts/purchasing.js';
import type { Item } from '../../contracts/catalog.js';
import type { DeliverLineInput, OpenDemand, ReservedQty, SalesOrderSnapshot, SalesOrderStatus, SalesService } from '../../contracts/sales.js';
import { SO_V1 } from './eco.js';
import { createReports } from './reports.js';

export interface SalesOrder {
  id: number;
  number: string | null;
  customer_id: number;
  order_date: string;
  customer_reference: string | null;
  ship_to: string | null;
  currency: string;
  exchange_rate: number;
  price_list_id: number | null;
  priority: number;
  payment_terms_days: number;
  warehouse_id: number | null;
  status: SalesOrderStatus;
  short_closed: number;
  notes: string | null;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  base_total: number;
  credit_override_by: number | null;
  confirmed_at: string | null;
}

export interface SoLine {
  id: number;
  so_id: number;
  line_no: number;
  item_id: number;
  description: string;
  quantity: number;
  unit_price: number;
  price_source: 'list' | 'item' | 'manual';
  discount_bp: number;
  tax_id: number | null;
  tax_rate_bp: number;
  gross: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
  requested_date: string;
  promised_date: string | null;
  warehouse_id: number | null;
  delivered_qty: number;
  invoiced_qty: number;
  cancelled_qty: number;
}

export interface Delivery {
  id: number;
  number: string | null;
  so_id: number;
  customer_id: number;
  date: string;
  ship_to: string | null;
  reference: string | null;
  external_ref: string | null;
  notes: string | null;
  status: 'draft' | 'posted' | 'void';
  journal_entry_id: number | null;
  void_entry_id: number | null;
}

export interface DeliveryLine {
  id: number;
  delivery_id: number;
  line_no: number;
  so_line_id: number;
  item_id: number;
  warehouse_id: number | null;
  qty: number;
  lots: string | null;
  cost: number;
  invoiced_qty: number;
}

export interface OrderInput {
  customerId: number;
  orderDate: string;
  customerReference?: string | null;
  shipTo?: string | null;
  currency?: string | null;
  exchangeRate?: number | null;
  priority?: number;
  warehouseId?: number | null;
  notes?: string | null;
  lines: {
    itemId: number;
    description?: string | null;
    quantity: number;
    /** null / undefined = the customer's price list, else the item's sale price. */
    unitPrice?: number | null;
    discountBp?: number;
    /** undefined = the item's sales tax; null = no tax. */
    taxId?: number | null;
    requestedDate?: string | null;
    warehouseId?: number | null;
  }[];
}

export interface DeliveryInput {
  soId: number;
  date: string;
  shipTo?: string | null;
  reference?: string | null;
  externalRef?: string | null;
  notes?: string | null;
  /** Left out: everything still open on the order. */
  lines?: { soLineId: number; qty: number; warehouseId?: number | null; lots?: { lotNo: string; qty: number }[] | null }[] | null;
}

export interface AtpQuery {
  itemId: number;
  qty: number;
  /** The date the customer wants it (availability is never earlier). */
  date: string;
  warehouseId?: number | null;
  /** Leave this order line's own demand and reservation out (re-checking a confirmed line). */
  excludeLineId?: number | null;
  /** "Today" for the check (default: the real today). */
  asOf?: string | null;
}

export interface AtpEvent {
  date: string;
  kind: 'stock' | 'purchase' | 'plan' | 'order';
  reference: string | null;
  qty: number;
  cumulative: number;
}

export interface AtpResult {
  itemId: number;
  qty: number;
  date: string;
  warehouseId: number | null;
  stockControlled: boolean;
  onHand: number;
  reserved: number;
  /** On hand − reserved, never below zero. */
  free: number;
  availableNow: boolean;
  /** First date on or after `date` from which the full quantity stays available; null = not within known supply. */
  availableDate: string | null;
  timeline: AtpEvent[];
}

const OPEN_STATUSES = "('confirmed', 'partially_delivered')";
const openOf = (l: Pick<SoLine, 'quantity' | 'delivered_qty' | 'cancelled_qty'>) => l.quantity - l.delivered_qty - l.cancelled_qty;
const share = (amount: number, part: number, whole: number) => (whole ? Number(divRound(BigInt(amount) * BigInt(part), BigInt(whole))) : 0);

export type SalesInternal = ReturnType<typeof createSales>;

/**
 * Sales & distribution, modelled on SAP SD and kept small: sales order → (reservation, ATP) →
 * outbound delivery (goods issue at moving-average cost) → billing from the delivery (the
 * invoice does not move stock again). Money only moves in the books through the inventory
 * service (cost of sales) and the documents engine (the invoice).
 */
export function createSales(ctx: ModuleContext) {
  const { db, services, events, apps } = ctx;
  const catalog = () => services.get('catalog');
  const parties = () => services.get('parties');
  const audit = () => services.get('audit');
  const inventoryOn = () => services.has('inventory') && apps.isEnabled('inventory');
  const inv = () => services.get('inventory');
  const isStock = (item: Item) => inventoryOn() && catalog().isStockItem(item);
  const baseCurrency = () => services.get('settings').company().baseCurrency;
  const fxOn = () => services.has('fx') && apps.isEnabled('fx');
  const taxOn = () => services.has('tax') && apps.isEnabled('tax');

  // a confirmed order's snapshot is rebuilt before the transaction commits (eco coalesces, publishes only real changes)
  const ecoChanged = (id: number) => services.has('eco') && services.get('eco').changed(SO_V1, id);
  const order = (id: number) => db.get<SalesOrder>('SELECT * FROM sales_orders WHERE id = ?', [id]) ?? notFound('sales_order', id);
  const lines = (soId: number) => db.all<SoLine>('SELECT * FROM sales_order_lines WHERE so_id = ? ORDER BY line_no', [soId]);
  const line = (id: number) => db.get<SoLine>('SELECT * FROM sales_order_lines WHERE id = ?', [id]) ?? notFound('sales_order_line', id);
  const delivery = (id: number) => db.get<Delivery>('SELECT * FROM sales_deliveries WHERE id = ?', [id]) ?? notFound('sales_delivery', id);
  const deliveryLines = (id: number) => db.all<DeliveryLine>('SELECT * FROM sales_delivery_lines WHERE delivery_id = ? ORDER BY line_no', [id]);

  // ------------------------------------------------------------ reservations
  const reservationOf = (lineId: number) =>
    db.get<{ item_id: number; warehouse_id: number; qty: number }>('SELECT item_id, warehouse_id, qty FROM sales_reservations WHERE so_line_id = ?', [lineId]) ?? null;

  function reservedQty(itemId: number, warehouseId: number): number {
    return db.get<{ q: number }>('SELECT COALESCE(SUM(qty), 0) q FROM sales_reservations WHERE item_id = ? AND warehouse_id = ?', [itemId, warehouseId])!.q;
  }

  function reserved(filter: { itemId?: number | null; warehouseId?: number | null } = {}): ReservedQty[] {
    const where: string[] = [];
    const p: number[] = [];
    if (filter.itemId) (where.push('item_id = ?'), p.push(filter.itemId));
    if (filter.warehouseId) (where.push('warehouse_id = ?'), p.push(filter.warehouseId));
    return db.all<ReservedQty>(
      `SELECT item_id AS itemId, warehouse_id AS warehouseId, SUM(qty) AS qty FROM sales_reservations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY item_id, warehouse_id ORDER BY item_id, warehouse_id`,
      p,
    );
  }

  function setReservation(l: SoLine, warehouseId: number, qty: number) {
    if (qty <= 0) db.run('DELETE FROM sales_reservations WHERE so_line_id = ?', [l.id]);
    else
      db.run(
        `INSERT INTO sales_reservations (so_line_id, item_id, warehouse_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(so_line_id) DO UPDATE SET item_id = excluded.item_id, warehouse_id = excluded.warehouse_id, qty = excluded.qty, updated_at = excluded.updated_at`,
        [l.id, l.item_id, warehouseId, qty, nowIso()],
      );
  }

  /** After goods left that other orders had reserved: reservations never exceed the stock, the least urgent lines give theirs up first. */
  function trimReservations(itemId: number, warehouseId: number) {
    let over = reservedQty(itemId, warehouseId) - Math.max(0, inv().onHand(itemId, warehouseId));
    if (over <= 0) return;
    const rows = db.all<{ so_line_id: number; qty: number }>(
      `SELECT r.so_line_id, r.qty FROM sales_reservations r JOIN sales_order_lines l ON l.id = r.so_line_id JOIN sales_orders o ON o.id = l.so_id
       WHERE r.item_id = ? AND r.warehouse_id = ? ORDER BY o.priority DESC, COALESCE(l.promised_date, l.requested_date) DESC, l.id DESC`, [itemId, warehouseId]);
    for (const r of rows) {
      if (over <= 0) break;
      const cut = Math.min(r.qty, over);
      setReservation(line(r.so_line_id), warehouseId, r.qty - cut);
      over -= cut;
    }
  }

  /** The warehouse a line ships from: its own, the order's, else the default one. */
  function lineWarehouse(l: SoLine, o: SalesOrder): number | null {
    if (l.warehouse_id) return l.warehouse_id;
    if (o.warehouse_id) return o.warehouse_id;
    return inventoryOn() ? inv().defaultWarehouse() : null;
  }

  /**
   * Reserve what the line still needs from free stock (on hand − everybody's reservations), never more.
   * Returns the line's reservation after the top-up.
   */
  function topUp(l: SoLine, o: SalesOrder): number {
    const item = catalog().item(l.item_id);
    if (!isStock(item)) return 0;
    const wh = lineWarehouse(l, o)!;
    if (l.warehouse_id !== wh) db.run('UPDATE sales_order_lines SET warehouse_id = ? WHERE id = ?', [wh, l.id]);
    const cur = reservationOf(l.id);
    // A reservation in another warehouse is given back; the line reserves where it ships from.
    const mine = cur && cur.warehouse_id === wh ? cur.qty : 0;
    const free = Math.max(0, inv().onHand(item.id, wh) - reservedQty(item.id, wh));
    const target = Math.max(0, Math.min(openOf(l), mine + free));
    setReservation({ ...l, warehouse_id: wh }, wh, target);
    return target;
  }

  // --------------------------------------------------------------------- ATP
  function openDemand(itemId?: number | null): OpenDemand[] {
    return db.all<OpenDemand>(
      `SELECT o.id AS orderId, o.number AS orderNumber, l.id AS lineId, o.customer_id AS customerId, l.item_id AS itemId,
              COALESCE(l.warehouse_id, o.warehouse_id) AS warehouseId, o.priority, l.requested_date AS requestedDate, l.promised_date AS promisedDate,
              l.quantity - l.delivered_qty - l.cancelled_qty AS openQty, COALESCE(r.qty, 0) AS reservedQty
       FROM sales_order_lines l JOIN sales_orders o ON o.id = l.so_id LEFT JOIN sales_reservations r ON r.so_line_id = l.id
       WHERE o.status IN ${OPEN_STATUSES} AND l.quantity - l.delivered_qty - l.cancelled_qty > 0 ${itemId ? 'AND l.item_id = ?' : ''}
       ORDER BY o.priority, COALESCE(l.promised_date, l.requested_date), l.id`,
      itemId ? [itemId] : [],
    );
  }

  /**
   * Available-to-promise: free stock now, plus open purchase-order receipts by their expected date,
   * plus planned production (sales_supply_plan), minus other confirmed demand not yet covered by a
   * reservation, by its date. The answer is the first date from which the full quantity stays available.
   */
  function atp(q: AtpQuery): AtpResult {
    const item = catalog().item(q.itemId);
    const asOf = q.asOf ?? today();
    const start = q.date > asOf ? q.date : asOf;
    const wh = q.warehouseId ?? null;
    const stockControlled = isStock(item);
    if (!stockControlled) {
      return { itemId: item.id, qty: q.qty, date: q.date, warehouseId: wh, stockControlled, onHand: 0, reserved: 0, free: 0, availableNow: true, availableDate: start, timeline: [] };
    }
    const defaultWh = inv().defaultWarehouse();
    const whMatch = (w: number | null) => !wh || (w ?? defaultWh) === wh;
    const onHand = inv().onHand(item.id, wh);
    const own = q.excludeLineId ? reservationOf(q.excludeLineId) : null;
    const allReserved = wh ? reservedQty(item.id, wh) : reserved({ itemId: item.id }).reduce((s, r) => s + r.qty, 0);
    const reservedOthers = allReserved - (own && whMatch(own.warehouse_id) ? own.qty : 0);
    const opening = onHand - reservedOthers;

    const ev: Omit<AtpEvent, 'cumulative'>[] = [];
    const at = (d: string) => (d < asOf ? asOf : d);
    if (services.has('purchaseSupply') && apps.isEnabled('purchasing')) {
      for (const s of services.get('purchaseSupply').openSupply(item.id)) if (whMatch(s.warehouseId)) ev.push({ date: at(s.date), kind: 'purchase', reference: s.poNumber, qty: s.qty });
    }
    for (const s of db.all<{ date: string; qty: number; source: string; reference: string | null }>('SELECT date, qty, source, reference FROM sales_supply_plan WHERE item_id = ? AND date >= ?', [item.id, asOf])) {
      ev.push({ date: s.date, kind: 'plan', reference: s.reference ?? s.source, qty: s.qty });
    }
    for (const d of openDemand(item.id)) {
      if (d.lineId === q.excludeLineId || !whMatch(d.warehouseId)) continue;
      const uncovered = d.openQty - d.reservedQty;
      if (uncovered > 0) ev.push({ date: at(d.promisedDate ?? d.requestedDate), kind: 'order', reference: d.orderNumber, qty: -uncovered });
    }
    ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.qty - a.qty));

    // Cumulative availability after each event; opening applies from `asOf`.
    let cum = opening;
    const timeline: AtpEvent[] = [{ date: asOf, kind: 'stock', reference: null, qty: opening, cumulative: opening }];
    for (const e of ev) {
      cum += e.qty;
      timeline.push({ ...e, cumulative: cum });
    }
    // Balance on a date = opening + every event up to and including that date.
    const balanceOn = (d: string) => opening + ev.filter((e) => e.date <= d).reduce((s, e) => s + e.qty, 0);
    const candidates = [start, ...new Set(ev.map((e) => e.date).filter((d) => d > start))];
    let availableDate: string | null = null;
    for (const d of candidates) {
      const later = [d, ...ev.map((e) => e.date).filter((x) => x > d)];
      if (later.every((x) => balanceOn(x) >= q.qty)) {
        availableDate = d;
        break;
      }
    }
    return {
      itemId: item.id,
      qty: q.qty,
      date: q.date,
      warehouseId: wh,
      stockControlled,
      onHand,
      reserved: reservedOthers,
      free: Math.max(0, opening),
      availableNow: availableDate === start,
      availableDate,
      timeline,
    };
  }

  /** Reserve from stock, then promise the rest from ATP (never before the requested date). */
  function reserveAndPromise(l: SoLine, o: SalesOrder, asOf: string) {
    const item = catalog().item(l.item_id);
    if (!isStock(item)) {
      db.run('UPDATE sales_order_lines SET promised_date = ? WHERE id = ?', [l.requested_date, l.id]);
      return;
    }
    const got = topUp(l, o);
    let promised: string | null = l.requested_date;
    // ATP counts the line's own reservation as its supply, so it asks for the whole open quantity.
    if (openOf(l) - got > 0) promised = atp({ itemId: l.item_id, qty: openOf(l), date: l.requested_date, warehouseId: lineWarehouse(l, o), excludeLineId: l.id, asOf }).availableDate;
    db.run('UPDATE sales_order_lines SET promised_date = ? WHERE id = ?', [promised, l.id]);
  }

  // ------------------------------------------------------------------ orders
  function currencyOf(input: OrderInput): { currency: string; rate: number } {
    const currency = (input.currency ?? baseCurrency()).toUpperCase();
    if (currency === baseCurrency()) return { currency, rate: 1_000_000 };
    if (!fxOn()) fail('fx.unavailable', 'Multi-currency is switched off');
    const fx = services.get('fx');
    fx.assertCurrency(currency);
    const rate = input.exchangeRate ?? fx.rate(currency, input.orderDate);
    if (!Number.isSafeInteger(rate) || rate <= 0) fail('fx.invalid_rate', 'Invalid exchange rate');
    return { currency, rate };
  }

  function write(id: number | null, input: OrderInput, userId: number | null): number {
    const party = parties().get(input.customerId);
    parties().assertKind(party, 'customer');
    if (!input.lines.length) fail('sales.no_lines', 'Add at least one line');
    if (input.warehouseId && inventoryOn()) inv().warehouse(input.warehouseId);
    const { currency, rate } = currencyOf(input);
    const list = services.has('pricing') ? services.get('pricing').listFor(party.id) : null;
    const computed = input.lines.map((l, i) => {
      const n = i + 1;
      const item = catalog().item(l.itemId);
      if (!item.is_active) fail('document.inactive_item', `Line ${n}: item ${item.sku} is inactive`, { line: n });
      if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0) fail('document.line_quantity', `Line ${n}: quantity must be positive`, { line: n });
      if (l.warehouseId && inventoryOn()) inv().warehouse(l.warehouseId);
      let unitPrice = l.unitPrice ?? null;
      let source: SoLine['price_source'] = 'manual';
      if (unitPrice == null) {
        const listed = list ? services.get('pricing').price(list.id, item.id, null) : null;
        // List and item prices are in the base currency; a foreign order converts them at the order's rate.
        const basePrice = listed ?? item.sale_price;
        source = listed != null ? 'list' : 'item';
        unitPrice = currency === baseCurrency() ? basePrice : Number(divRound(BigInt(basePrice) * 1_000_000n, BigInt(rate)));
      }
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) fail('document.line_price', `Line ${n}: invalid price`, { line: n });
      const taxId = taxOn() ? (l.taxId === undefined ? item.sales_tax_id : l.taxId) : null;
      let rateBp = 0;
      if (taxId) {
        const t = services.get('tax').get(taxId);
        if (!t.is_active) fail('document.inactive_tax', `Line ${n}: tax ${t.code} is inactive`, { line: n });
        if (t.scope === 'purchases') fail('document.tax_scope', `Line ${n}: tax ${t.code} is not for sales`, { line: n });
        rateBp = t.rate_bp;
      }
      const requested = l.requestedDate ?? input.orderDate;
      if (requested < input.orderDate) fail('sales.requested_before_order', `Line ${n}: the requested date is before the order date`, { line: n });
      const c = computeLine({ quantity: l.quantity, unitPrice, discountBp: l.discountBp ?? 0, rateBp }, false);
      return {
        line_no: n,
        item_id: item.id,
        description: (l.description ?? '').trim() || item.name_en,
        quantity: l.quantity,
        unit_price: unitPrice,
        price_source: source,
        discount_bp: l.discountBp ?? 0,
        tax_id: taxId ?? null,
        tax_rate_bp: rateBp,
        ...c,
        requested_date: requested,
        warehouse_id: l.warehouseId ?? null,
      };
    });
    const header = {
      customer_id: party.id,
      order_date: input.orderDate,
      customer_reference: input.customerReference ?? null,
      ship_to: input.shipTo ?? party.address ?? null,
      currency,
      exchange_rate: rate,
      price_list_id: list?.id ?? null,
      priority: input.priority ?? 5,
      payment_terms_days: party.payment_terms_days,
      warehouse_id: input.warehouseId ?? null,
      notes: input.notes ?? null,
      subtotal: sum(computed.map((l) => l.net)),
      discount_total: sum(computed.map((l) => l.discount)),
      tax_total: sum(computed.map((l) => l.tax)),
      total: sum(computed.map((l) => l.total)),
      base_total: sum(computed.map((l) => fxToBase(l.net, rate) + fxToBase(l.tax, rate))),
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let soId = id;
      if (soId == null) soId = db.insert('sales_orders', { ...header, status: 'draft', created_by: userId, created_at: nowIso() });
      else {
        db.update('sales_orders', soId, header);
        db.run('DELETE FROM sales_order_lines WHERE so_id = ?', [soId]);
      }
      for (const l of computed) db.insert('sales_order_lines', { ...l, so_id: soId });
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'sales_order', entityId: soId });
      return soId;
    });
  }

  function update(id: number, input: OrderInput, userId: number | null) {
    if (order(id).status !== 'draft') conflict('sales.not_draft', 'Only draft orders can be edited');
    write(id, input, userId);
  }

  /** What the customer would owe if every open order were invoiced: ledger balance + uninvoiced order value (with tax). */
  function creditExposure(customerId: number, exceptOrderId: number | null) {
    const balance = parties().receivableBalance(customerId);
    const rows = db.all<{ total: number; quantity: number; invoiced_qty: number; cancelled_qty: number; exchange_rate: number }>(
      `SELECT l.total, l.quantity, l.invoiced_qty, l.cancelled_qty, o.exchange_rate FROM sales_order_lines l JOIN sales_orders o ON o.id = l.so_id
       WHERE o.customer_id = ? AND o.status IN ${OPEN_STATUSES} AND o.id <> ?`,
      [customerId, exceptOrderId ?? 0],
    );
    const open = rows.reduce((s, r) => s + fxToBase(share(r.total, r.quantity - r.invoiced_qty - r.cancelled_qty, r.quantity), r.exchange_rate), 0);
    return { balance, open };
  }

  function confirm(id: number, opts: { override?: boolean }, user: { id: number | null; can(p: string): boolean }) {
    const o = order(id);
    if (o.status !== 'draft') conflict('sales.not_draft', 'Only draft orders can be confirmed');
    const ls = lines(id);
    if (!ls.length) fail('sales.no_lines', 'Add at least one line');
    const party = parties().get(o.customer_id);
    parties().assertKind(party, 'customer');
    if (services.has('pricing')) {
      services.get('pricing').assertMinimum(
        ls.map((l) => ({ lineNo: l.line_no, itemId: l.item_id, baseNet: fxToBase(l.net, o.exchange_rate), baseQty: l.quantity })),
        user.id,
      );
    }
    let overrideBy: number | null = null;
    if (party.credit_limit != null) {
      const { balance, open } = creditExposure(party.id, id);
      const exposure = balance + open + o.base_total;
      if (exposure > party.credit_limit) {
        if (!opts.override || !user.can('sales.orders.override')) {
          fail('sales.credit_limit', `${party.name} would exceed the credit limit`, { balance, open, order: o.base_total, exposure, limit: party.credit_limit });
        }
        overrideBy = user.id;
      }
    }
    db.tx(() => {
      const number = services.get('sequences').next('sales_order');
      db.run(`UPDATE sales_orders SET status = 'confirmed', number = ?, confirmed_by = ?, confirmed_at = ?, credit_override_by = ?, updated_at = ? WHERE id = ?`, [
        number,
        user.id,
        nowIso(),
        overrideBy,
        nowIso(),
        id,
      ]);
      const fresh = order(id);
      for (const l of ls) reserveAndPromise(l, fresh, o.order_date);
      ecoChanged(id);
      audit().log({ userId: user.id, action: 'confirm', entity: 'sales_order', entityId: id, summary: number, data: overrideBy ? { creditOverride: true } : undefined });
      events.emit('sales.order.confirmed', { orderId: id, userId: user.id });
    });
  }

  /** Recompute the order status from its lines (deliveries move it). */
  function refreshStatus(soId: number) {
    const o = order(soId);
    if (o.status === 'draft' || o.status === 'cancelled') return;
    const ls = lines(soId);
    const done = ls.every((l) => openOf(l) <= 0);
    const any = ls.some((l) => l.delivered_qty > 0);
    const next: SalesOrderStatus = done || o.short_closed ? 'closed' : any ? 'partially_delivered' : 'confirmed';
    if (next !== o.status) db.run('UPDATE sales_orders SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?', [next, next === 'closed' ? nowIso() : null, nowIso(), soId]);
    if (next === 'closed') db.run('DELETE FROM sales_reservations WHERE so_line_id IN (SELECT id FROM sales_order_lines WHERE so_id = ?)', [soId]);
    ecoChanged(soId);
  }

  function cancel(id: number, userId: number | null) {
    const o = order(id);
    if (o.status === 'closed' || o.status === 'cancelled') conflict('sales.cannot_cancel', 'This order is already closed');
    if (lines(id).some((l) => l.delivered_qty > 0) || db.get("SELECT 1 FROM sales_deliveries WHERE so_id = ? AND status <> 'void'", [id])) {
      conflict('sales.has_deliveries', 'Goods were already delivered (or a delivery is prepared) — close the order instead');
    }
    db.tx(() => {
      db.run('DELETE FROM sales_reservations WHERE so_line_id IN (SELECT id FROM sales_order_lines WHERE so_id = ?)', [id]);
      db.run(`UPDATE sales_orders SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), id]);
      ecoChanged(id);
      audit().log({ userId, action: 'cancel', entity: 'sales_order', entityId: id, summary: o.number });
    });
  }

  /** Short close: what is not delivered yet is given up and its reservation released. */
  function close(id: number, userId: number | null) {
    const o = order(id);
    if (o.status !== 'confirmed' && o.status !== 'partially_delivered') conflict('sales.not_open', 'Only open orders can be closed');
    if (db.get("SELECT 1 FROM sales_deliveries WHERE so_id = ? AND status = 'draft'", [id])) conflict('sales.draft_delivery', 'Post or delete the prepared delivery first');
    db.tx(() => {
      db.run('UPDATE sales_order_lines SET cancelled_qty = quantity - delivered_qty WHERE so_id = ?', [id]);
      db.run('UPDATE sales_orders SET short_closed = 1 WHERE id = ?', [id]);
      refreshStatus(id);
      ecoChanged(id);
      audit().log({ userId, action: 'close', entity: 'sales_order', entityId: id, summary: o.number });
    });
  }

  /** Re-run reservation and promising for the open lines of an order (after stock arrived, for example). */
  function reschedule(id: number, userId: number | null, asOf = today()) {
    const o = order(id);
    if (o.status !== 'confirmed' && o.status !== 'partially_delivered') conflict('sales.not_open', 'Only open orders can be rescheduled');
    db.tx(() => {
      for (const l of lines(id)) if (openOf(l) > 0) reserveAndPromise(l, o, asOf);
      ecoChanged(id);
      audit().log({ userId, action: 'reschedule', entity: 'sales_order', entityId: id, summary: o.number });
    });
  }

  function promise(lineId: number, date: string | null, userId: number | null) {
    const l = line(lineId);
    const o = order(l.so_id);
    if (o.status !== 'confirmed' && o.status !== 'partially_delivered') conflict('sales.not_open', 'Only open orders can be promised');
    if (date && date < o.order_date) fail('sales.promised_before_order', 'The promised date is before the order date');
    db.tx(() => {
      db.run('UPDATE sales_order_lines SET promised_date = ? WHERE id = ?', [date, lineId]);
      ecoChanged(o.id);
      audit().log({ userId, action: 'promise', entity: 'sales_order', entityId: o.id, summary: `${o.number} line ${l.line_no} → ${date ?? '—'}` });
    });
  }

  function remove(id: number, userId: number | null) {
    const o = order(id);
    if (o.status !== 'draft') conflict('sales.not_draft', 'Only drafts can be deleted');
    db.tx(() => {
      db.run('DELETE FROM sales_orders WHERE id = ?', [id]);
      ecoChanged(id);
      audit().log({ userId, action: 'delete', entity: 'sales_order', entityId: id });
    });
  }

  // -------------------------------------------------------------- deliveries
  function writeDelivery(id: number | null, input: DeliveryInput, userId: number | null): number {
    const o = order(input.soId);
    if (o.status !== 'confirmed' && o.status !== 'partially_delivered') conflict('sales.not_open', 'Only confirmed orders can be delivered');
    const ls = new Map(lines(o.id).map((l) => [l.id, l]));
    const wanted =
      input.lines && input.lines.length
        ? input.lines
        : [...ls.values()].filter((l) => openOf(l) > 0).map((l) => ({ soLineId: l.id, qty: openOf(l), warehouseId: null, lots: null }));
    if (!wanted.length) fail('sales.nothing_to_deliver', 'Nothing is left to deliver on this order');
    const rows = wanted.map((w, i) => {
      const l = ls.get(w.soLineId) ?? fail('sales.other_order', `Line ${i + 1}: that line belongs to another order`, { line: i + 1 });
      if (!Number.isSafeInteger(w.qty) || w.qty <= 0) fail('document.line_quantity', `Line ${i + 1}: quantity must be positive`, { line: i + 1 });
      if (w.qty > openOf(l)) fail('sales.over_delivery', `Line ${i + 1}: only ${openOf(l) / 1000} is left to deliver`, { line: i + 1, left: openOf(l) / 1000 });
      const wh = w.warehouseId ?? lineWarehouse(l, o);
      if (wh && inventoryOn()) inv().warehouse(wh);
      return { line_no: i + 1, so_line_id: l.id, item_id: l.item_id, warehouse_id: wh, qty: w.qty, lots: w.lots?.length ? JSON.stringify(w.lots) : null };
    });
    const header = {
      so_id: o.id,
      customer_id: o.customer_id,
      date: input.date,
      ship_to: input.shipTo ?? o.ship_to,
      reference: input.reference ?? null,
      external_ref: input.externalRef ?? null,
      notes: input.notes ?? null,
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let did = id;
      if (did == null) did = db.insert('sales_deliveries', { ...header, status: 'draft', created_by: userId, created_at: nowIso() });
      else {
        db.update('sales_deliveries', did, header);
        db.run('DELETE FROM sales_delivery_lines WHERE delivery_id = ?', [did]);
      }
      for (const r of rows) db.insert('sales_delivery_lines', { ...r, delivery_id: did });
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'sales_delivery', entityId: did });
      return did;
    });
  }

  function updateDelivery(id: number, input: DeliveryInput, userId: number | null) {
    const d = delivery(id);
    if (d.status !== 'draft') conflict('sales.not_draft', 'Only prepared deliveries can be edited');
    if (d.so_id !== input.soId) fail('sales.other_order', 'A delivery stays on its order');
    writeDelivery(id, { ...input, externalRef: d.external_ref }, userId);
  }

  /** Post the goods issue: stock leaves at moving-average cost, the reservation is released, the order moves on. */
  function postDelivery(id: number, userId: number | null) {
    const d = delivery(id);
    if (d.status !== 'draft') conflict('sales.not_draft', 'This delivery is already posted');
    const o = order(d.so_id);
    if (o.status !== 'confirmed' && o.status !== 'partially_delivered') conflict('sales.not_open', 'The order is not open');
    const dls = deliveryLines(id);
    // Two lines of the same order line add up.
    const perLine = new Map<number, number>();
    for (const dl of dls) perLine.set(dl.so_line_id, (perLine.get(dl.so_line_id) ?? 0) + dl.qty);
    for (const [lid, q] of perLine) {
      const l = line(lid);
      if (q > openOf(l)) fail('sales.over_delivery', `Line ${l.line_no}: only ${openOf(l) / 1000} is left to deliver`, { line: l.line_no, left: openOf(l) / 1000 });
    }
    db.tx(() => {
      const number = services.get('sequences').next('sales_delivery');
      const stockLines: { dl: DeliveryLine; wh: number }[] = [];
      // Goods already taken by earlier lines of this delivery (they leave together below).
      const taken = new Map<string, number>();
      for (const dl of dls) {
        const item = catalog().item(dl.item_id);
        if (!isStock(item)) continue;
        const l = line(dl.so_line_id);
        const wh = dl.warehouse_id ?? lineWarehouse(l, o)!;
        // What this line may take: free stock plus its own reservation in that warehouse. A dispatch fact from manufacturing (its reference
        // is `eco:...`) is different: the goods have already left the plant, so what other orders have reserved cannot refuse it; only
        // stock that is not there at all can (production not booked yet), and the other reservations shrink to what is left below.
        const own = reservationOf(l.id);
        const mine = own && own.warehouse_id === wh ? own.qty : 0;
        const key = `${item.id}:${wh}`;
        const left = inv().onHand(item.id, wh) - (taken.get(key) ?? 0);
        const free = d.external_ref?.startsWith('eco:') ? left : left - reservedQty(item.id, wh) + mine;
        taken.set(key, (taken.get(key) ?? 0) + dl.qty);
        if (dl.qty > free) {
          const code = inv().warehouse(wh).code;
          fail('sales.not_available', `Not enough ${item.sku} free in ${code}: ${Math.max(0, free) / 1000} available`, { sku: item.sku, warehouse: code, available: Math.max(0, free) / 1000, requested: dl.qty / 1000 });
        }
        // The goods leave: first from this line's reservation.
        if (own) setReservation(l, own.warehouse_id, own.warehouse_id === wh ? own.qty - Math.min(dl.qty, own.qty) : Math.min(own.qty, openOf(l) - dl.qty));
        stockLines.push({ dl, wh });
      }
      let entryId: number | null = null;
      if (stockLines.length) {
        const res = inv().issue({
          date: d.date,
          sourceType: 'sales_delivery',
          sourceId: d.id,
          reference: number,
          memo: `${number} — ${parties().get(o.customer_id).name} (${o.number})`,
          userId,
          lines: stockLines.map(({ dl, wh }) => ({ lineId: dl.id, itemId: dl.item_id, warehouseId: wh, qty: dl.qty, lots: dl.lots ? JSON.parse(dl.lots) : null })),
        });
        entryId = res.entryId;
        stockLines.forEach(({ dl, wh }, i) => db.run('UPDATE sales_delivery_lines SET cost = ?, warehouse_id = ? WHERE id = ?', [res.values[i], wh, dl.id]));
        if (d.external_ref?.startsWith('eco:')) for (const k of new Set(stockLines.map(({ dl, wh }) => `${dl.item_id}:${wh}`))) trimReservations(Number(k.split(':')[0]), Number(k.split(':')[1]));
      } else if (!dls.length) fail('sales.nothing_to_deliver', 'Nothing to deliver');
      for (const [lid, q] of perLine) {
        db.run('UPDATE sales_order_lines SET delivered_qty = delivered_qty + ? WHERE id = ?', [q, lid]);
        const l = line(lid);
        const r = reservationOf(lid);
        if (r && r.qty > openOf(l)) setReservation(l, r.warehouse_id, openOf(l));
      }
      db.run(`UPDATE sales_deliveries SET status = 'posted', number = ?, journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE id = ?`, [number, entryId, nowIso(), nowIso(), id]);
      refreshStatus(o.id);
      audit().log({ userId, action: 'post', entity: 'sales_delivery', entityId: id, summary: number });
      events.emit('sales.delivery.posted', { deliveryId: id, userId });
    });
  }

  function voidDelivery(id: number, opts: { date?: string | null }, userId: number | null) {
    const d = delivery(id);
    if (d.status !== 'posted') conflict('sales.not_posted', 'Only posted deliveries can be voided');
    const dls = deliveryLines(id);
    if (dls.some((l) => l.invoiced_qty > 0)) conflict('sales.delivery_invoiced', 'This delivery is invoiced — void the invoice first');
    const date = opts.date ?? d.date;
    db.tx(() => {
      // Voids always run, whatever was switched off since: they only undo what exists.
      const revId = services.has('inventory') ? services.get('inventory').reverseIssue('sales_delivery', d.id, date, `Void ${d.number}`, d.number, userId) : null;
      const shortClosed = !!order(d.so_id).short_closed;
      for (const dl of dls) {
        // On a short-closed order what comes back is given up too.
        db.run(`UPDATE sales_order_lines SET delivered_qty = delivered_qty - ?${shortClosed ? ', cancelled_qty = cancelled_qty + ?' : ''} WHERE id = ?`, shortClosed ? [dl.qty, dl.qty, dl.so_line_id] : [dl.qty, dl.so_line_id]);
      }
      db.run(`UPDATE sales_deliveries SET status = 'void', void_entry_id = ?, voided_at = ?, updated_at = ? WHERE id = ?`, [revId, nowIso(), nowIso(), id]);
      const o = order(d.so_id);
      if (!o.short_closed && o.status !== 'cancelled') {
        refreshStatus(o.id);
        // The goods are back: the lines may reserve them again.
        const fresh = order(o.id);
        if (fresh.status !== 'closed') for (const l of lines(o.id)) if (openOf(l) > 0) topUp(l, fresh);
      }
      audit().log({ userId, action: 'void', entity: 'sales_delivery', entityId: id, summary: d.number });
      events.emit('sales.delivery.voided', { deliveryId: id, userId });
    });
  }

  function removeDelivery(id: number, userId: number | null) {
    if (delivery(id).status !== 'draft') conflict('sales.not_draft', 'Only prepared deliveries can be deleted');
    db.tx(() => {
      db.run('DELETE FROM sales_deliveries WHERE id = ?', [id]);
      audit().log({ userId, action: 'delete', entity: 'sales_delivery', entityId: id });
    });
  }

  /** The integration entry point: deliver one order line, once per reference. */
  function deliverLine(input: DeliverLineInput): { deliveryId: number; created: boolean } {
    if (!input.reference?.trim()) fail('sales.reference_required', 'A reference is required (it makes the call safe to repeat)');
    const ref = input.reference.trim();
    const found = db.get<{ id: number }>('SELECT id FROM sales_deliveries WHERE external_ref = ?', [ref]);
    if (found) return { deliveryId: found.id, created: false };
    const l = line(input.soLineId);
    return db.tx(() => {
      const id = writeDelivery(null, { soId: l.so_id, date: input.date, reference: ref, externalRef: ref, lines: [{ soLineId: l.id, qty: input.qty, warehouseId: input.warehouseId ?? null, lots: input.lots ?? null }] }, input.userId);
      postDelivery(id, input.userId);
      return { deliveryId: id, created: true };
    });
  }

  // ---------------------------------------------------------------- invoicing
  /** A sales invoice (draft, or posted) billing what the chosen posted deliveries have not billed yet. */
  function invoiceFromDeliveries(input: { deliveryIds: number[]; date: string; post: boolean }, userId: number | null): number {
    if (!input.deliveryIds.length) fail('sales.nothing_to_invoice', 'Choose at least one delivery');
    const ds = [...new Set(input.deliveryIds)].map(delivery);
    const orders = new Map(ds.map((d) => [d.so_id, order(d.so_id)]));
    for (const d of ds) if (d.status !== 'posted') fail('sales.not_posted', `${d.number ?? 'A prepared delivery'} is not posted`);
    const customers = new Set(ds.map((d) => d.customer_id));
    if (customers.size > 1) fail('sales.invoice_mixed', 'One invoice bills one customer');
    const cur = new Set([...orders.values()].map((o) => `${o.currency}:${o.exchange_rate}`));
    if (cur.size > 1) fail('sales.invoice_mixed_currency', 'These orders are in different currencies or rates — invoice them separately');
    const first = [...orders.values()][0];
    const docLines = ds.flatMap((d) =>
      deliveryLines(d.id)
        .filter((dl) => dl.qty > dl.invoiced_qty)
        .map((dl) => {
          const l = line(dl.so_line_id);
          return {
            itemId: dl.item_id,
            description: l.description,
            quantity: dl.qty - dl.invoiced_qty,
            unitPrice: l.unit_price,
            discountBp: l.discount_bp,
            taxId: l.tax_id,
            warehouseId: dl.warehouse_id,
            ext: { deliveryLineId: dl.id, deliveryId: d.id, soLineId: l.id },
          };
        }),
    );
    if (!docLines.length) fail('sales.nothing_to_invoice', 'Everything on these deliveries is already invoiced');
    const numbers = [...orders.values()].map((o) => o.number).join(', ');
    const refs = [...new Set([...orders.values()].map((o) => o.customer_reference).filter(Boolean))].join(', ');
    const docs = services.get('documents');
    return db.tx(() => {
      const id = docs.create(
        {
          kind: 'sales_invoice',
          partyId: first.customer_id,
          date: input.date,
          dueDate: addDays(input.date, first.payment_terms_days),
          reference: (refs ? `${refs} / ${numbers}` : numbers).slice(0, 100),
          notes: `${ds.map((d) => d.number).join(', ')}`,
          currency: first.currency,
          exchangeRate: first.exchange_rate,
          lines: docLines,
        },
        userId,
      );
      if (input.post) docs.post(id, userId);
      return id;
    });
  }

  /** Invoice lines that bill a delivery move its "invoiced" counters (and back when voided). */
  function onInvoice(documentId: number, sign: 1 | -1) {
    const doc = services.get('documents').get(documentId);
    for (const l of services.get('documents').lines(documentId)) {
      const ext = l.ext ? (JSON.parse(l.ext) as Record<string, unknown>) : null;
      if (!ext?.deliveryLineId) continue;
      const dl = db.get<DeliveryLine>('SELECT * FROM sales_delivery_lines WHERE id = ?', [Number(ext.deliveryLineId)]) ?? notFound('sales_delivery_line', Number(ext.deliveryLineId));
      const d = delivery(dl.delivery_id);
      if (sign > 0) {
        if (d.status !== 'posted') fail('sales.not_posted', `Line ${l.line_no}: delivery ${d.number ?? ''} is not posted`, { line: l.line_no });
        if (d.customer_id !== doc.party_id) fail('sales.other_customer', `Line ${l.line_no}: that delivery went to another customer`, { line: l.line_no });
        if (dl.item_id !== l.item_id) fail('sales.other_item', `Line ${l.line_no}: the item differs from the delivery`, { line: l.line_no });
        const left = dl.qty - dl.invoiced_qty;
        if (l.base_quantity > left) fail('sales.over_invoiced', `Line ${l.line_no}: only ${left / 1000} of ${d.number} is left to invoice`, { line: l.line_no, left: left / 1000, number: d.number });
      }
      db.run('UPDATE sales_delivery_lines SET invoiced_qty = invoiced_qty + ? WHERE id = ?', [sign * l.base_quantity, dl.id]);
      db.run('UPDATE sales_order_lines SET invoiced_qty = invoiced_qty + ? WHERE id = ?', [sign * l.base_quantity, dl.so_line_id]);
    }
  }

  // ------------------------------------------------------------ publishing
  function orderSnapshots(opts: { status?: SalesOrderStatus[]; since?: string | null } = {}): SalesOrderSnapshot[] {
    const where = ["o.status <> 'draft'"];
    const p: (string | number)[] = [];
    if (opts.status?.length) (where.push(`o.status IN (${opts.status.map(() => '?').join(',')})`), p.push(...opts.status));
    if (opts.since) (where.push('o.order_date >= ?'), p.push(opts.since));
    const heads = db.all<SalesOrder & { customer_name: string }>(
      `SELECT o.*, pa.name AS customer_name FROM sales_orders o JOIN parties pa ON pa.id = o.customer_id WHERE ${where.join(' AND ')} ORDER BY o.order_date, o.id`,
      p,
    );
    return heads.map((o) => ({
      id: o.id,
      number: o.number,
      customerId: o.customer_id,
      customerName: o.customer_name,
      orderDate: o.order_date,
      customerReference: o.customer_reference,
      status: o.status,
      priority: o.priority,
      currency: o.currency,
      total: o.total,
      lines: db
        .all<SoLine & { sku: string; reserved: number | null }>(
          `SELECT l.*, i.sku, r.qty AS reserved FROM sales_order_lines l JOIN items i ON i.id = l.item_id LEFT JOIN sales_reservations r ON r.so_line_id = l.id
           WHERE l.so_id = ? ORDER BY l.line_no`,
          [o.id],
        )
        .map((l) => ({
          lineId: l.id,
          lineNo: l.line_no,
          itemId: l.item_id,
          sku: l.sku,
          qty: l.quantity,
          deliveredQty: l.delivered_qty,
          invoicedQty: l.invoiced_qty,
          reservedQty: l.reserved ?? 0,
          unitPrice: l.unit_price,
          requestedDate: l.requested_date,
          promisedDate: l.promised_date,
          warehouseId: l.warehouse_id,
        })),
    }));
  }

  function invoicedQty(fromMonth: string, toMonth: string) {
    return db.all<{ itemId: number; month: string; qty: number }>(
      `SELECT l.item_id AS itemId, substr(d.date, 1, 7) AS month,
              SUM(CASE WHEN d.kind = 'sales_invoice' THEN l.base_quantity ELSE -l.base_quantity END) AS qty
       FROM document_lines l JOIN documents d ON d.id = l.document_id
       WHERE d.kind IN ('sales_invoice', 'sales_credit') AND d.status = 'posted' AND l.item_id IS NOT NULL
         AND substr(d.date, 1, 7) BETWEEN ? AND ?
       GROUP BY l.item_id, month ORDER BY month, l.item_id`,
      [fromMonth, toMonth],
    );
  }

  function serviceLevel(from: string, to: string) {
    // measured as of the end of the period, or today when the period is not over: a line due later is not late yet
    const asOf = to < today() ? to : today();
    const t = createReports(ctx).otif({ from, to, groupBy: 'month', asOf }).totals;
    return { lines: t.lines, otdBp: t.otd_promised_bp, otifBp: t.otif_promised_bp, fillRateBp: t.fill_rate_bp };
  }

  const contract: SalesService = { reserved, reservedQty, openDemand, orderSnapshots, deliverLine, invoicedQty, serviceLevel };
  return {
    ...contract,
    order,
    lines,
    line,
    delivery,
    deliveryLines,
    reservationOf,
    atp,
    creditExposure,
    create: (i: OrderInput, u: number | null) => write(null, i, u),
    update,
    confirm,
    cancel,
    close,
    reschedule,
    promise,
    remove,
    createDelivery: (i: DeliveryInput, u: number | null) => writeDelivery(null, i, u),
    updateDelivery,
    postDelivery,
    voidDelivery,
    removeDelivery,
    invoiceFromDeliveries,
    onInvoice,
    openOf,
  };
}
