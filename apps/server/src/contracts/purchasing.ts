/** Open purchase-order supply — provided by the Purchasing module (always behind services.has('purchaseSupply')). */
export interface OpenPoSupply {
  poId: number;
  poNumber: string | null;
  lineId: number;
  itemId: number;
  warehouseId: number | null;
  /** When the goods are expected: the order's expected date, else its date. */
  date: string;
  /** Still to receive, base units × 1000. */
  qty: number;
}

export interface PurchaseSupplyService {
  /** Lines of approved (open) purchase orders that still have goods to receive. */
  openSupply(itemId?: number | null): OpenPoSupply[];
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    purchaseSupply: PurchaseSupplyService;
  }
}
