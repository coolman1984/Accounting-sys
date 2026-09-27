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

export interface TaxService {
  get(id: number): Tax;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    tax: TaxService;
  }
}
