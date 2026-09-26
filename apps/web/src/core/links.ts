import type { DocKind } from './types';

export const DOC_BASE: Record<DocKind, string> = {
  sales_invoice: '/sales/invoices',
  sales_credit: '/sales/credit-notes',
  purchase_bill: '/purchases/bills',
  purchase_credit: '/purchases/debit-notes',
};

const STOCK_SOURCES = new Set(['stock_adjustment', 'stock_opening', 'stock_count', 'stock_transfer', 'adjustment', 'opening', 'count', 'transfer']);

/** Where to open the document that produced a journal entry. */
export function sourceLink(sourceType: string, sourceId: number | null): string | null {
  if (!sourceId) return null;
  if (sourceType in DOC_BASE) return `${DOC_BASE[sourceType as DocKind]}/${sourceId}`;
  if (sourceType === 'receipt') return `/receipts/${sourceId}`;
  if (sourceType === 'payment') return `/payments/${sourceId}`;
  if (sourceType === 'cogs') return `/documents/${sourceId}`;
  if (STOCK_SOURCES.has(sourceType)) return `/inventory/operations/${sourceId}`;
  return null;
}
