import type { Item } from './catalog.js';

/** What other modules may ask the Inventory module (always behind services.has('inventory')). */
export interface Warehouse {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  address: string | null;
  is_active: number;
  is_default: number;
}

/** One production run: components out, one product in (quantities are base units × 1000). */
export interface ProductionInput {
  date: string;
  sourceId: number;
  reference: string | null;
  memo: string;
  userId: number | null;
  components: { itemId: number; warehouseId: number; qty: number; lineId?: number | null; lots?: { lotNo: string; qty: number }[] | null }[];
  output: { itemId: number; warehouseId: number; qty: number; lots?: { lotNo: string; expiry?: string | null; qty: number }[] | null };
  /** Labour and overhead applied to the product, credited to these accounts. */
  conversion: { accountId: number; amount: number }[];
}

export interface ProductionResult {
  entryId: number | null;
  /** Cost of each component line, in input order. */
  componentValues: number[];
  materials: number;
  conversion: number;
  outputValue: number;
}

/**
 * A goods issue made by another module (a sales delivery): each line leaves its warehouse at the
 * moving-average cost; one entry Dr cost of sales / Cr inventory. Quantities are base units × 1000.
 */
export interface IssueInput {
  date: string;
  /** Journal and stock-ledger source type, e.g. "sales_delivery". */
  sourceType: string;
  sourceId: number;
  reference: string | null;
  memo: string;
  userId: number | null;
  lines: { lineId: number; itemId: number; warehouseId: number; qty: number; lots?: { lotNo: string; qty: number }[] | null }[];
}

export interface IssueResult {
  entryId: number | null;
  /** Cost that left for each line, in input order (positive). */
  values: number[];
}

/** Net stock movement of a source line (qty < 0 = went out; value in base minor units, same sign). */
export interface LineCost {
  sourceId: number;
  sourceLineId: number;
  qty: number;
  value: number;
}

export interface InventoryService {
  warehouse(id: number): Warehouse;
  /** Has this item ever moved? (its tracking and stock flag are then locked) */
  hasMoves(itemId: number): boolean;
  /** Is this unit of measure used by any stock document? */
  unitUsed(unitId: number): boolean;
  /** Where a purchase line of a stock item is booked (GRNI when goods were already received), or null for the default. */
  purchaseLineAccount(item: Item, ext: Record<string, unknown> | null): number | null;
  /** Post a production run (source type "production", source id = the caller's order id). */
  produce(input: ProductionInput): ProductionResult;
  /** Undo the production run with this source id; returns the reversing journal entry. */
  reverseProduction(sourceId: number, date: string, conversion: { accountId: number; amount: number }[], memo: string, reference: string | null, userId: number | null): number | null;
  /** Current average cost of one unit (the purchase price when none is in stock). */
  unitCost(itemId: number): number;
  /** Quantity on hand (base × 1000) in one warehouse, or in all of them. */
  onHand(itemId: number, warehouseId?: number | null): number;
  defaultWarehouse(): number;
  /** Post a goods issue (e.g. a sales delivery). */
  issue(input: IssueInput): IssueResult;
  /** Undo the goods issue of this source: the goods come back at the cost they left at; returns the entry. */
  reverseIssue(sourceType: string, sourceId: number, date: string, memo: string, reference: string | null, userId: number | null): number | null;
  /** Net movement per source line of these sources (reversals included). */
  lineCosts(sourceType: string, sourceIds: number[]): LineCost[];
  /**
   * Stock another module has promised to someone (sales reservations). Sales invoices that are
   * not linked to a delivery may not take it; the function returns base qty × 1000.
   */
  registerReservations(fn: (itemId: number, warehouseId: number) => number): void;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    inventory: InventoryService;
  }
}
