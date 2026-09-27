/** Invoices, bills and credit notes — the billing engine shared by AR and AP. */
export const DOC_KINDS = ['sales_invoice', 'sales_credit', 'purchase_bill', 'purchase_credit'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export type DocSide = 'sales' | 'purchases';

export const KIND_INFO: Record<DocKind, { side: DocSide; /** +1 increases what the party owes us, -1 decreases it */ sign: 1 | -1; seq: string; prefix: string }> = {
  sales_invoice: { side: 'sales', sign: 1, seq: 'sales_invoice', prefix: 'INV-' },
  sales_credit: { side: 'sales', sign: -1, seq: 'sales_credit', prefix: 'CN-' },
  purchase_bill: { side: 'purchases', sign: -1, seq: 'purchase_bill', prefix: 'BILL-' },
  purchase_credit: { side: 'purchases', sign: 1, seq: 'purchase_credit', prefix: 'DN-' },
};

export interface Document {
  id: number;
  kind: DocKind;
  number: string | null;
  party_id: number;
  date: string;
  due_date: string;
  reference: string | null;
  notes: string | null;
  currency: string;
  tax_inclusive: number;
  status: 'draft' | 'posted' | 'void';
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  amount_settled: number;
  against_document_id: number | null;
  journal_entry_id: number | null;
  void_entry_id: number | null;
  warehouse_id: number | null;
  created_at: string;
  posted_at: string | null;
}

export interface DocumentLine {
  id: number;
  line_no: number;
  item_id: number | null;
  description: string;
  quantity: number;
  unit_price: number;
  discount_bp: number;
  account_id: number;
  tax_id: number | null;
  tax_rate_bp: number;
  warehouse_id: number | null;
  unit_id: number | null;
  unit_factor: number;
  base_quantity: number;
  ext: string | null;
  cost_center_id: number | null;
  gross: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
}

/** How a document kind is exposed: AR registers the sales kinds, AP the purchase kinds. */
export interface DocKindInfo {
  /** Permission prefix, e.g. "ar.invoices" → ar.invoices.read / .write / .post */
  perm: string;
}

/** A side (sales / purchases) and the permission to see its reports (ageing). */
export interface DocSideInfo {
  reportPerm: string;
}

export interface DocumentsService {
  get(id: number): Document;
  lines(id: number): DocumentLine[];
  settle(documentId: number, s: { sourceType: 'payment' | 'credit'; sourceId: number; sourceNumber: string | null; amount: number; date: string }): void;
  unsettleSource(sourceType: 'payment' | 'credit', sourceId: number): void;
  registerKind(kind: DocKind, info: DocKindInfo): void;
  registerSide(side: DocSide, info: DocSideInfo): void;
  kind(kind: DocKind): DocKindInfo | null;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    documents: DocumentsService;
  }
}
