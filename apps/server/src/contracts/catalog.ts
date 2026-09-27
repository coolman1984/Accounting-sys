/** Products & services — master data shared by AR, AP, Inventory, Purchasing and Pricing. */
export interface Item {
  id: number;
  sku: string;
  name_en: string;
  name_ar: string;
  kind: 'service' | 'product';
  unit: string | null;
  sale_price: number;
  purchase_price: number;
  income_account_id: number | null;
  expense_account_id: number | null;
  sales_tax_id: number | null;
  purchase_tax_id: number | null;
  description: string | null;
  is_active: number;
  barcode: string | null;
  category_id: number | null;
  /** Products are stock-tracked unless this is 0 (consumables). */
  track_stock: number;
  inventory_account_id: number | null;
  cogs_account_id: number | null;
  /** x1000, like every quantity. */
  reorder_level: number;
  reorder_qty: number;
  /** none | batch (lots, optional expiry) | serial (one unit per number). */
  tracking: 'none' | 'batch' | 'serial';
  requires_expiry: number;
  /** Lowest allowed net selling price per base unit (0 = no guard). */
  min_sale_price: number;
}

/** An alternative unit of measure: 1 unit = factor/1000 base units (a box of 12 => 12000). */
export interface ItemUnit {
  id: number;
  item_id: number;
  name_en: string;
  name_ar: string;
  factor: number;
  barcode: string | null;
  sale_price: number | null;
  purchase_price: number | null;
  is_active: number;
}

export interface CatalogService {
  item(id: number): Item;
  /** Does this item carry a stock balance? */
  isStockItem(item: Item): boolean;
  unit(id: number): ItemUnit;
  units(itemId: number): ItemUnit[];
  /** Conversion factor (x1000) of a unit for an item; null unit = base unit (1000). */
  unitFactor(item: Item, unitId: number | null | undefined): number;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    catalog: CatalogService;
  }
}
