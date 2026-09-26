import { FileMinus, FilePlus, FileText, ReceiptText } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import type { DocKind } from '../../core/types';
import { DocumentList } from './DocumentList';
import { DocumentEditor } from './DocumentEditor';
import { DocumentView } from './DocumentView';
import { KIND_UI } from './kinds';

const routesFor = (kind: DocKind) => {
  const base = KIND_UI[kind].base;
  return [
    { path: base, element: <DocumentList key={kind} kind={kind} /> },
    { path: `${base}/new`, element: <DocumentEditor key={kind + '-new'} kind={kind} /> },
    { path: `${base}/:id`, element: <DocumentView key={kind + '-view'} kind={kind} /> },
    { path: `${base}/:id/edit`, element: <DocumentEditor key={kind + '-edit'} kind={kind} /> },
  ];
};

export const documentsModule: WebModule = {
  id: 'documents',
  nav: [
    { to: '/sales/invoices', label: 'nav.invoices', icon: FileText, section: 'sales', order: 10, perm: 'sales.read' },
    { to: '/sales/credit-notes', label: 'nav.creditNotes', icon: FileMinus, section: 'sales', order: 20, perm: 'sales.read' },
    { to: '/purchases/bills', label: 'nav.bills', icon: ReceiptText, section: 'purchases', order: 10, perm: 'purchases.read' },
    { to: '/purchases/debit-notes', label: 'nav.debitNotes', icon: FilePlus, section: 'purchases', order: 20, perm: 'purchases.read' },
  ],
  routes: (['sales_invoice', 'sales_credit', 'purchase_bill', 'purchase_credit'] as DocKind[]).flatMap(routesFor),
  commands: [
    { id: 'new-invoice', label: 'docs.sales_invoice.new', icon: FileText, group: 'create', to: '/sales/invoices/new', perm: 'sales.write', keywords: 'invoice فاتورة بيع' },
    { id: 'new-credit', label: 'docs.sales_credit.new', icon: FileMinus, group: 'create', to: '/sales/credit-notes/new', perm: 'sales.write', keywords: 'return credit مرتجع' },
    { id: 'new-bill', label: 'docs.purchase_bill.new', icon: ReceiptText, group: 'create', to: '/purchases/bills/new', perm: 'purchases.write', keywords: 'bill purchase شراء' },
    { id: 'new-debit', label: 'docs.purchase_credit.new', icon: FilePlus, group: 'create', to: '/purchases/debit-notes/new', perm: 'purchases.write', keywords: 'debit return مرتجع' },
    { id: 'go-invoices', label: 'nav.invoices', icon: FileText, group: 'navigate', to: '/sales/invoices', perm: 'sales.read', keywords: 'sales مبيعات' },
    { id: 'go-bills', label: 'nav.bills', icon: ReceiptText, group: 'navigate', to: '/purchases/bills', perm: 'purchases.read', keywords: 'purchases مشتريات' },
  ],
};
