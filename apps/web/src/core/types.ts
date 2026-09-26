/** Shapes returned by the Mizan API (amounts are integer minor units). */
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type DocKind = 'sales_invoice' | 'sales_credit' | 'purchase_bill' | 'purchase_credit';
export type Direction = 'in' | 'out';

export interface Company {
  name: string;
  legalName: string | null;
  taxNumber: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  baseCurrency: string;
  moneyScale: number;
}

export interface Me {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'accountant' | 'viewer';
  locale: 'en' | 'ar';
  permissions: string[];
}

export interface Account {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  type: AccountType;
  subtype: string;
  parent_id: number | null;
  is_group: number;
  is_active: number;
  description: string | null;
  depth: number;
  balance: number;
  has_postings: boolean;
}

export interface Party {
  id: number;
  kind: 'customer' | 'supplier' | 'both';
  code: string;
  name: string;
  name_alt: string | null;
  tax_number: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  receivable_account_id: number | null;
  payable_account_id: number | null;
  payment_terms_days: number;
  credit_limit: number | null;
  notes: string | null;
  is_active: number;
  receivable: number;
  payable: number;
}

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
}

export interface JournalLine {
  id: number;
  line_no: number;
  account_id: number;
  account_code: string;
  account_name_en: string;
  account_name_ar: string;
  party_id: number | null;
  party_name: string | null;
  description: string | null;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  id: number;
  number: string | null;
  date: string;
  reference: string | null;
  memo: string | null;
  source_type: string;
  source_id: number | null;
  status: 'draft' | 'posted';
  total: number;
  reversal_of_id: number | null;
  reversed_by_id: number | null;
  created_at: string;
  posted_at: string | null;
  lines: JournalLine[];
}

export interface DocumentRow {
  id: number;
  kind: DocKind;
  number: string | null;
  date: string;
  due_date: string;
  reference: string | null;
  status: 'draft' | 'posted' | 'void';
  subtotal: number;
  tax_total: number;
  total: number;
  amount_settled: number;
  party_id: number;
  party_name: string;
}

export interface DocumentLine {
  id: number;
  line_no: number;
  item_id: number | null;
  item_sku: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  discount_bp: number;
  account_id: number;
  account_code: string;
  account_name_en: string;
  account_name_ar: string;
  tax_id: number | null;
  tax_code: string | null;
  tax_rate_bp: number;
  gross: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
}

export interface DocumentFull extends Omit<DocumentRow, 'party_name'> {
  notes: string | null;
  currency: string;
  tax_inclusive: number;
  discount_total: number;
  against_document_id: number | null;
  against_number: string | null;
  journal_entry_id: number | null;
  journal_number: string | null;
  void_entry_id: number | null;
  void_journal_number: string | null;
  party: Party;
  lines: DocumentLine[];
  settlements: { id: number; source_type: 'payment' | 'credit'; source_id: number; source_number: string | null; amount: number; date: string }[];
  applied: { id: number; document_id: number; amount: number; date: string; number: string }[];
  posted_at: string | null;
  created_at: string;
}

export interface PaymentRow {
  id: number;
  direction: Direction;
  number: string | null;
  date: string;
  party_id: number | null;
  party_role: 'customer' | 'supplier' | null;
  party_name: string | null;
  account_id: number;
  account_code: string;
  account_name_en: string;
  account_name_ar: string;
  counter_account_id: number | null;
  counter_code: string | null;
  counter_name_en: string | null;
  counter_name_ar: string | null;
  amount: number;
  allocated: number;
  method: string | null;
  reference: string | null;
  memo: string | null;
  status: 'draft' | 'posted' | 'void';
}

export interface Paged<T> {
  rows: T[];
  total: number;
  sums?: Record<string, number>;
}

export interface FiscalYear {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
  closing_entry_id: number | null;
  closed_at: string | null;
}
