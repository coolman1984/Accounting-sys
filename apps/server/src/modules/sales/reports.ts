import type { ModuleContext } from '../../kernel/modules.js';
import { daysBetween, today } from '../../kernel/dates.js';
import { divRound, fxToBase } from '../../kernel/money.js';
import type {} from '../../contracts/inventory.js';

export type GroupBy = 'customer' | 'item' | 'month';

const bp = (part: number, whole: number) => (whole ? Number(divRound(BigInt(part) * 10000n, BigInt(whole))) : 0);
const share = (amount: number, part: number, whole: number) => (whole ? Number(divRound(BigInt(amount) * BigInt(part), BigInt(whole))) : 0);

interface MeasuredLine {
  line_id: number;
  so_id: number;
  so_number: string;
  line_no: number;
  customer_id: number;
  customer_name: string;
  item_id: number;
  sku: string;
  name_en: string;
  name_ar: string;
  quantity: number;
  requested_date: string;
  promised_date: string | null;
}

/**
 * Delivery performance and sales KPIs, read from the module's own orders and deliveries and from
 * posted invoices. Definitions (per order line, the unit SAP and most retail contracts measure):
 *  - a line is measured when its due date (promised, else requested) is in the period and has
 *    passed, or when it is already delivered in full;
 *  - OTD = the first posted delivery is on or before the due date (promised / requested);
 *  - OTIF = the full ordered quantity was delivered on or before that date;
 *  - fill rate = delivered quantity ÷ ordered quantity of the measured lines.
 */
export function createReports({ db, services }: ModuleContext) {
  const groupKey = (g: GroupBy, r: { customer_id: number; item_id: number; month: string }) => (g === 'customer' ? r.customer_id : g === 'item' ? r.item_id : r.month);

  function otif(q: { from: string; to: string; groupBy: GroupBy; asOf?: string }) {
    const asOf = q.asOf ?? today();
    const lines = db.all<MeasuredLine & { delivered_qty: number }>(
      `SELECT l.id AS line_id, o.id AS so_id, o.number AS so_number, l.line_no, o.customer_id, pa.name AS customer_name,
              l.item_id, i.sku, i.name_en, i.name_ar, l.quantity, l.requested_date, l.promised_date, l.delivered_qty
       FROM sales_order_lines l JOIN sales_orders o ON o.id = l.so_id JOIN parties pa ON pa.id = o.customer_id JOIN items i ON i.id = l.item_id
       WHERE o.status IN ('confirmed', 'partially_delivered', 'closed')
         AND COALESCE(l.promised_date, l.requested_date) BETWEEN ? AND ?
       ORDER BY COALESCE(l.promised_date, l.requested_date), l.id`,
      [q.from, q.to],
    );
    const dels = new Map<number, { date: string; qty: number }[]>();
    if (lines.length) {
      for (const d of db.all<{ so_line_id: number; date: string; qty: number }>(
        `SELECT dl.so_line_id, d.date, SUM(dl.qty) qty FROM sales_delivery_lines dl JOIN sales_deliveries d ON d.id = dl.delivery_id
         WHERE d.status = 'posted' AND dl.so_line_id IN (SELECT l.id FROM sales_order_lines l JOIN sales_orders o ON o.id = l.so_id
                                                         WHERE COALESCE(l.promised_date, l.requested_date) BETWEEN ? AND ?)
         GROUP BY dl.so_line_id, d.date ORDER BY d.date`,
        [q.from, q.to],
      )) {
        const list = dels.get(d.so_line_id) ?? [];
        list.push({ date: d.date, qty: d.qty });
        dels.set(d.so_line_id, list);
      }
    }
    const details = lines
      .map((l) => {
        const due = l.promised_date ?? l.requested_date;
        const ds = dels.get(l.line_id) ?? [];
        const delivered = ds.reduce((s, d) => s + d.qty, 0);
        return { l, due, ds, delivered };
      })
      // Not yet measurable: due later and not complete.
      .filter((x) => x.due <= asOf || x.delivered >= x.l.quantity)
      .map(({ l, due, ds, delivered }) => {
        const first = ds[0]?.date ?? null;
        const byDue = ds.filter((d) => d.date <= due).reduce((s, d) => s + d.qty, 0);
        const byReq = ds.filter((d) => d.date <= l.requested_date).reduce((s, d) => s + d.qty, 0);
        return {
          ...l,
          due_date: due,
          month: due.slice(0, 7),
          first_delivery: first,
          last_delivery: ds.length ? ds[ds.length - 1].date : null,
          delivered,
          days_late: first ? Math.max(0, daysBetween(due, first)) : Math.max(0, daysBetween(due, asOf)),
          otd_promised: !!first && first <= due,
          otd_requested: !!first && first <= l.requested_date,
          otif_promised: byDue >= l.quantity,
          otif_requested: byReq >= l.quantity,
        };
      });
    type Agg = { key: string | number; label: string; lines: number; otd_promised: number; otd_requested: number; otif_promised: number; otif_requested: number; ordered: number; delivered: number };
    const groups = new Map<string | number, Agg>();
    const total: Agg = { key: 'total', label: '', lines: 0, otd_promised: 0, otd_requested: 0, otif_promised: 0, otif_requested: 0, ordered: 0, delivered: 0 };
    for (const d of details) {
      const k = groupKey(q.groupBy, d);
      const label = q.groupBy === 'customer' ? d.customer_name : q.groupBy === 'item' ? d.sku : d.month;
      const g = groups.get(k) ?? { key: k, label, lines: 0, otd_promised: 0, otd_requested: 0, otif_promised: 0, otif_requested: 0, ordered: 0, delivered: 0 };
      for (const a of [g, total]) {
        a.lines++;
        a.otd_promised += +d.otd_promised;
        a.otd_requested += +d.otd_requested;
        a.otif_promised += +d.otif_promised;
        a.otif_requested += +d.otif_requested;
        a.ordered += d.quantity;
        a.delivered += Math.min(d.delivered, d.quantity);
      }
      groups.set(k, g);
    }
    const withPct = (a: Agg) => ({
      ...a,
      otd_promised_bp: bp(a.otd_promised, a.lines),
      otd_requested_bp: bp(a.otd_requested, a.lines),
      otif_promised_bp: bp(a.otif_promised, a.lines),
      otif_requested_bp: bp(a.otif_requested, a.lines),
      fill_rate_bp: bp(a.delivered, a.ordered),
    });
    return { ...q, asOf, rows: [...groups.values()].map(withPct).sort((a, b) => String(a.label).localeCompare(String(b.label))), totals: withPct(total), details };
  }

  /** Open order lines (confirmed, not yet delivered) with their value at the order price, in base currency. */
  function openLines(asOf: string) {
    return db
      .all<{
        line_id: number;
        so_id: number;
        so_number: string;
        order_date: string;
        priority: number;
        customer_id: number;
        customer_name: string;
        item_id: number;
        sku: string;
        name_en: string;
        name_ar: string;
        quantity: number;
        open_qty: number;
        reserved_qty: number;
        net: number;
        exchange_rate: number;
        requested_date: string;
        promised_date: string | null;
      }>(
        `SELECT l.id AS line_id, o.id AS so_id, o.number AS so_number, o.order_date, o.priority, o.customer_id, pa.name AS customer_name,
                l.item_id, i.sku, i.name_en, i.name_ar, l.quantity, l.quantity - l.delivered_qty - l.cancelled_qty AS open_qty,
                COALESCE(r.qty, 0) AS reserved_qty, l.net, o.exchange_rate, l.requested_date, l.promised_date
         FROM sales_order_lines l JOIN sales_orders o ON o.id = l.so_id JOIN parties pa ON pa.id = o.customer_id JOIN items i ON i.id = l.item_id
         LEFT JOIN sales_reservations r ON r.so_line_id = l.id
         WHERE o.status IN ('confirmed', 'partially_delivered') AND l.quantity - l.delivered_qty - l.cancelled_qty > 0 AND o.order_date <= ?
         ORDER BY o.order_date, l.id`,
        [asOf],
      )
      .map((l) => {
        const due = l.promised_date ?? l.requested_date;
        return {
          ...l,
          due_date: due,
          open_value: fxToBase(share(l.net, l.open_qty, l.quantity), l.exchange_rate),
          age_days: Math.max(0, daysBetween(l.order_date, asOf)),
          days_late: Math.max(0, daysBetween(due, asOf)),
          late: due < asOf,
        };
      });
  }

  function backlog(q: { groupBy: 'customer' | 'item'; asOf?: string }) {
    const asOf = q.asOf ?? today();
    const rows = openLines(asOf);
    const groups = new Map<number, { key: number; label: string; lines: number; open_qty: number; reserved_qty: number; open_value: number; late_qty: number; late_value: number }>();
    const totals = { lines: 0, open_qty: 0, reserved_qty: 0, open_value: 0, late_qty: 0, late_value: 0 };
    for (const r of rows) {
      const key = q.groupBy === 'customer' ? r.customer_id : r.item_id;
      const g = groups.get(key) ?? { key, label: q.groupBy === 'customer' ? r.customer_name : r.sku, lines: 0, open_qty: 0, reserved_qty: 0, open_value: 0, late_qty: 0, late_value: 0 };
      for (const a of [g, totals]) {
        a.lines++;
        a.open_qty += r.open_qty;
        a.reserved_qty += r.reserved_qty;
        a.open_value += r.open_value;
        if (r.late) (a.late_qty += r.open_qty), (a.late_value += r.open_value);
      }
      groups.set(key, g);
    }
    return { ...q, asOf, rows: [...groups.values()].sort((a, b) => b.open_value - a.open_value), totals, details: rows };
  }

  /** Open orders by age since the order date (buckets) and whether they are late against their due date. */
  function aging(q: { asOf?: string }) {
    const asOf = q.asOf ?? today();
    const buckets = ['d0_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
    const bucketOf = (age: number): (typeof buckets)[number] => (age <= 30 ? 'd0_30' : age <= 60 ? 'd31_60' : age <= 90 ? 'd61_90' : 'd90_plus');
    const rows = openLines(asOf).map((r) => ({ ...r, bucket: bucketOf(r.age_days) }));
    const totals = Object.fromEntries(buckets.map((b) => [b, { lines: 0, qty: 0, value: 0, late_value: 0 }])) as Record<(typeof buckets)[number], { lines: number; qty: number; value: number; late_value: number }>;
    for (const r of rows) {
      const t = totals[r.bucket];
      t.lines++;
      t.qty += r.open_qty;
      t.value += r.open_value;
      if (r.late) t.late_value += r.open_value;
    }
    return { asOf, buckets, totals, rows };
  }

  /**
   * Sales by customer / item / month from posted invoices and credit notes (base currency):
   * quantity, revenue (net of discount, before tax), cost of the goods and margin. The cost of an
   * invoice line that bills a delivery is the delivery's cost for the billed share.
   */
  function sales(q: { from: string; to: string; groupBy: GroupBy }) {
    const lines = db.all<{
      doc_id: number;
      line_id: number;
      kind: string;
      date: string;
      customer_id: number;
      customer_name: string;
      item_id: number | null;
      sku: string | null;
      base_quantity: number;
      base_net: number;
      ext: string | null;
    }>(
      `SELECT d.id AS doc_id, l.id AS line_id, d.kind, d.date, d.party_id AS customer_id, pa.name AS customer_name, l.item_id, i.sku,
              l.base_quantity, l.base_net, l.ext
       FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN parties pa ON pa.id = d.party_id LEFT JOIN items i ON i.id = l.item_id
       WHERE d.kind IN ('sales_invoice', 'sales_credit') AND d.status = 'posted' AND d.date BETWEEN ? AND ?`,
      [q.from, q.to],
    );
    const cost = new Map<string, number>();
    if (services.has('inventory')) {
      const invSvc = services.get('inventory');
      for (const kind of ['sales_invoice', 'sales_credit']) {
        const ids = [...new Set(lines.filter((l) => l.kind === kind).map((l) => l.doc_id))];
        for (const c of invSvc.lineCosts(kind, ids)) cost.set(`${c.sourceId}:${c.sourceLineId}`, -c.value);
      }
    }
    const dlCost = new Map(db.all<{ id: number; qty: number; cost: number }>('SELECT id, qty, cost FROM sales_delivery_lines').map((x) => [x.id, x]));
    type Agg = { key: string | number; label: string; qty: number; revenue: number; cost: number };
    const groups = new Map<string | number, Agg>();
    const totals: Agg = { key: 'total', label: '', qty: 0, revenue: 0, cost: 0 };
    for (const l of lines) {
      const sign = l.kind === 'sales_invoice' ? 1 : -1;
      const ext = l.ext ? (JSON.parse(l.ext) as Record<string, unknown>) : null;
      let c = cost.get(`${l.doc_id}:${l.line_id}`) ?? 0;
      const dl = ext?.deliveryLineId ? dlCost.get(Number(ext.deliveryLineId)) : undefined;
      if (dl) c = share(dl.cost, l.base_quantity, dl.qty);
      const month = l.date.slice(0, 7);
      const k = groupKey(q.groupBy, { customer_id: l.customer_id, item_id: l.item_id ?? 0, month });
      const label = q.groupBy === 'customer' ? l.customer_name : q.groupBy === 'item' ? l.sku ?? '—' : month;
      const g = groups.get(k) ?? { key: k, label, qty: 0, revenue: 0, cost: 0 };
      for (const a of [g, totals]) {
        a.qty += sign * (l.item_id ? l.base_quantity : 0);
        a.revenue += sign * l.base_net;
        // Credit-note costs are already signed (goods coming back are a negative cost).
        a.cost += c;
      }
      groups.set(k, g);
    }
    const fin = (a: Agg) => ({ ...a, margin: a.revenue - a.cost, margin_bp: bp(a.revenue - a.cost, a.revenue) });
    return { ...q, rows: [...groups.values()].map(fin).sort((a, b) => (q.groupBy === 'month' ? String(a.key).localeCompare(String(b.key)) : b.revenue - a.revenue)), totals: fin(totals) };
  }

  return { otif, backlog, aging, sales, openLines };
}
