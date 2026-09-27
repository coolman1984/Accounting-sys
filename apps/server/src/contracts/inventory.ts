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

export interface InventoryService {
  warehouse(id: number): Warehouse;
  /** Has this item ever moved? (its tracking and stock flag are then locked) */
  hasMoves(itemId: number): boolean;
  /** Is this unit of measure used by any stock document? */
  unitUsed(unitId: number): boolean;
  /** Where a purchase line of a stock item is booked (GRNI when goods were already received), or null for the default. */
  purchaseLineAccount(item: Item, ext: Record<string, unknown> | null): number | null;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    inventory: InventoryService;
  }
}
