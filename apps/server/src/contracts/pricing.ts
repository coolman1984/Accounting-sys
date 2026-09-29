/** Price lists and the minimum-price guard — provided by the Pricing module (always behind services.has('pricing')). */
export interface PriceListRef {
  id: number;
  name_en: string;
  name_ar: string;
}

export interface PricingService {
  /** The customer's active price list, or null (also null while the Price lists app is off). */
  listFor(partyId: number): PriceListRef | null;
  /** Price of an item on a list, per base unit (unitId null) or per alternative unit; null when not listed. */
  price(listId: number, itemId: number, unitId?: number | null): number | null;
  /**
   * The minimum selling price guard (net per base unit, after discount, before tax, base currency).
   * Throws `price.below_minimum` unless the user holds pricing.minprice.override or the app is off.
   */
  assertMinimum(lines: { lineNo: number; itemId: number | null; baseNet: number; baseQty: number }[], userId: number | null): void;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    pricing: PricingService;
  }
}
