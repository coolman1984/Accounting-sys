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
  /** Base units per one document-currency unit × 1,000,000 (1,000,000 in the base currency). */
  exchange_rate: number;
  tax_inclusive: number;
  status: 'draft' | 'posted' | 'void';
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  amount_settled: number;
  /** The same figures in the base currency — what the books, stock and reports use. */
  base_subtotal: number;
  base_tax_total: number;
  base_total: number;
  base_settled: number;
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
  base_net: number;
  base_tax: number;
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

/** Input of an invoice, bill or note (the same as POST /documents). */
export interface DocLineInput {
  itemId?: number | null;
  description?: string | null;
  /** x1000 */
  quantity: number;
  unitPrice: number;
  discountBp?: number;
  accountId?: number | null;
  taxId?: number | null;
  /** Overrides the document's warehouse for this line. */
  warehouseId?: number | null;
  /** Alternative unit of measure (null = the item's base unit); quantity and price are in this unit. */
  unitId?: number | null;
  /** Controlling dimension (CO module). */
  costCenterId?: number | null;
  /**
   * Extension data other modules attach to a line (lots/serials, links to goods
   * receipts or purchase orders). Stored as-is; the owning module validates it.
   */
  ext?: Record<string, unknown> | null;
}

export interface DocInput {
  kind: DocKind;
  partyId: number;
  date: string;
  dueDate?: string | null;
  reference?: string | null;
  notes?: string | null;
  taxInclusive?: boolean;
  againstDocumentId?: number | null;
  /** Default warehouse for stock lines. */
  warehouseId?: number | null;
  /** Document currency (default: the company's) and its rate (default: the day's rate). */
  currency?: string | null;
  exchangeRate?: number | null;
  lines: DocLineInput[];
}

/** What settled part of an invoice or bill: a receipt/payment, a credit note, a cheque, or a letter of credit. */
export type SettlementSource = 'payment' | 'credit' | 'cheque' | 'lc';

export interface DocumentsService {
  get(id: number): Document;
  lines(id: number): DocumentLine[];
  /** `baseAmount` defaults to {@link baseFor}; `sourceBaseAmount` is the settling side's base value (credit notes). */
  settle(
    documentId: number,
    s: { sourceType: SettlementSource; sourceId: number; sourceNumber: string | null; amount: number; date: string; baseAmount?: number; sourceBaseAmount?: number },
  ): void;
  /** Base value of settling `amount` of a document: its rate, or exactly what is left when it clears the document. */
  baseFor(doc: Document, amount: number): number;
  unsettleSource(sourceType: SettlementSource, sourceId: number): void;
  registerKind(kind: DocKind, info: DocKindInfo): void;
  registerSide(side: DocSide, info: DocSideInfo): void;
  kind(kind: DocKind): DocKindInfo | null;
  /** Create a draft document (validated like POST /documents; the caller checks rights). */
  create(input: DocInput, userId: number | null): number;
  /** Post a draft document. */
  post(id: number, userId: number | null): void;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    documents: DocumentsService;
  }
}
