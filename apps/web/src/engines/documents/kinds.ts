import { FileMinus, FilePlus, FileText, ReceiptText } from 'lucide-react';
import type { DocKind } from '../../core/types';

export const KIND_UI: Record<
  DocKind,
  {
    side: 'sales' | 'purchases';
    partyKind: 'customer' | 'supplier';
    base: string;
    icon: typeof FileText;
    creditOf?: DocKind;
    /** Permission prefix of the page (AR / AP): `${perm}.read|write|post`. */
    perm: string;
    /** The app that sells it. */
    app: 'ar' | 'ap';
  }
> = {
  sales_invoice: { side: 'sales', partyKind: 'customer', base: '/sales/invoices', icon: FileText, perm: 'ar.invoices', app: 'ar' },
  sales_credit: { side: 'sales', partyKind: 'customer', base: '/sales/credit-notes', icon: FileMinus, creditOf: 'sales_invoice', perm: 'ar.credits', app: 'ar' },
  purchase_bill: { side: 'purchases', partyKind: 'supplier', base: '/purchases/bills', icon: ReceiptText, perm: 'ap.bills', app: 'ap' },
  purchase_credit: { side: 'purchases', partyKind: 'supplier', base: '/purchases/debit-notes', icon: FilePlus, creditOf: 'purchase_bill', perm: 'ap.debits', app: 'ap' },
};

/** Permission prefix of a partner role's pages. */
export const PARTY_PERM = { customer: 'ar.customers', supplier: 'ap.suppliers' } as const;

export { computeLine } from '../../core/money';
