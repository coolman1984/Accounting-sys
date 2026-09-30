/**
 * Sales & distribution (sales orders, reservations, ATP, deliveries) — provided by the Sales module
 * (always behind services.has('sales')). Other modules read it here: S&OP (firm orders, invoiced history),
 * and later the ecosystem integration (reserved stock, order snapshots, deliveries from shop-floor events).
 */
export type SalesOrderStatus = 'draft' | 'confirmed' | 'partially_delivered' | 'closed' | 'cancelled';

export interface ReservedQty {
  itemId: number;
  warehouseId: number;
  /** Base units × 1000. */
  qty: number;
}

/** An open, confirmed order line (the firm demand). */
export interface OpenDemand {
  orderId: number;
  orderNumber: string | null;
  lineId: number;
  customerId: number;
  itemId: number;
  warehouseId: number | null;
  priority: number;
  requestedDate: string;
  promisedDate: string | null;
  /** Ordered − delivered, base units × 1000. */
  openQty: number;
  reservedQty: number;
}

export interface SalesOrderSnapshotLine {
  lineId: number;
  lineNo: number;
  itemId: number;
  sku: string;
  qty: number;
  deliveredQty: number;
  invoicedQty: number;
  reservedQty: number;
  unitPrice: number;
  requestedDate: string;
  promisedDate: string | null;
  warehouseId: number | null;
}

export interface SalesOrderSnapshot {
  id: number;
  number: string | null;
  customerId: number;
  customerName: string;
  orderDate: string;
  customerReference: string | null;
  status: SalesOrderStatus;
  priority: number;
  currency: string;
  total: number;
  lines: SalesOrderSnapshotLine[];
}

export interface DeliverLineInput {
  soLineId: number;
  /** Base units × 1000. */
  qty: number;
  date: string;
  /** Default: the order line's warehouse. */
  warehouseId?: number | null;
  /** Idempotency key, e.g. "eco:<event id>": the same reference never delivers twice. */
  reference: string;
  /** The serial or batch numbers that leave, for tracked items (quantities x1000). */
  lots?: { lotNo: string; qty: number }[] | null;
  userId: number | null;
}

export interface SalesService {
  /** Reserved stock per item × warehouse (all, or filtered). */
  reserved(filter?: { itemId?: number | null; warehouseId?: number | null }): ReservedQty[];
  reservedQty(itemId: number, warehouseId: number): number;
  /** Confirmed lines still to deliver. */
  openDemand(itemId?: number | null): OpenDemand[];
  /** Orders with their lines, for publishing (status filter optional; dates on or after `since`, the order date). */
  orderSnapshots(opts?: { status?: SalesOrderStatus[]; since?: string | null }): SalesOrderSnapshot[];
  /** Deliver (and post) one order line — idempotent on `reference`. */
  deliverLine(input: DeliverLineInput): { deliveryId: number; created: boolean };
  /** Net invoiced quantity per item and month (posted invoices − credit notes), for demand history. */
  invoicedQty(fromMonth: string, toMonth: string): { itemId: number; month: string; qty: number }[];
  /** Delivery performance of the order lines due in a period (YYYY-MM-DD): on time, on time in full, and fill rate, in basis points. */
  serviceLevel(from: string, to: string): { lines: number; otdBp: number; otifBp: number; fillRateBp: number };
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    sales: SalesService;
  }
}

declare module '../kernel/events.js' {
  interface EventMap {
    'sales.order.confirmed': { orderId: number; userId: number | null };
    'sales.delivery.posted': { deliveryId: number; userId: number | null };
    'sales.delivery.voided': { deliveryId: number; userId: number | null };
  }
}
