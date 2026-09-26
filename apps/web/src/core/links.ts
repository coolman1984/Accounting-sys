import type { DocKind } from './types';

export const DOC_BASE: Record<DocKind, string> = {
  sales_invoice: '/sales/invoices',
  sales_credit: '/sales/credit-notes',
  purchase_bill: '/purchases/bills',
  purchase_credit: '/purchases/debit-notes',
};

/** Where to open the document that produced a journal entry. */
export function sourceLink(sourceType: string, sourceId: number | null): string | null {
  if (!sourceId) return null;
  if (sourceType in DOC_BASE) return `${DOC_BASE[sourceType as DocKind]}/${sourceId}`;
  if (sourceType === 'receipt') return `/receipts/${sourceId}`;
  if (sourceType === 'payment') return `/payments/${sourceId}`;
  return null;
}
