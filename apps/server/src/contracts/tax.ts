/** Tax codes (VAT) — provided by the Tax module. */
export interface Tax {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  rate_bp: number;
  scope: 'sales' | 'purchases' | 'both';
  sales_account_id: number | null;
  purchase_account_id: number | null;
  is_active: number;
}

/**
 * Egypt's withholding scheme (نظام الخصم والإضافة تحت حساب الضريبة, Income Tax Law 91/2005 and its
 * executive regulations): the payer deducts a share of each payment for supplies, contracting,
 * services or commissions, on the value before VAT, and pays it to the Tax Authority with Form 41.
 */
export type WhtType = 'supplies' | 'contracting' | 'services' | 'commissions';
export const WHT_TYPES: WhtType[] = ['supplies', 'contracting', 'services', 'commissions'];

export interface WhtSettings {
  /** The company deducts from its suppliers (every company and partnership is required to). */
  agent: boolean;
  /** Payments whose value before VAT is below this are not subject (minor units; 300 EGP). */
  minBase: number;
  /** Rates in basis points by type. */
  rates: Record<WhtType, number>;
}

export interface TaxService {
  get(id: number): Tax;
  /** Withholding settings (with the defaults of the executive regulations). */
  withholding(): WhtSettings;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    tax: TaxService;
  }
}
