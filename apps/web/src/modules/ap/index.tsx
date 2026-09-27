import { Clock, FilePlus, ReceiptText, Truck } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { documentRoutes, DocumentRedirect } from '../../engines/documents';
import { SideOverview } from '../../engines/documents/Overview';
import { PartyList, PartyView } from '../../engines/parties';
import { AgingPage } from '../../engines/parties/Aging';

/** Accounts Payable (like SAP FI-AP): suppliers, bills, debit notes and supplier ageing. */
export const apModule: WebModule = {
  id: 'ap',
  nav: [
    { to: '/purchases/bills', label: 'nav.bills', icon: ReceiptText, section: 'purchases', order: 10, perm: 'ap.bills.read', app: 'ap' },
    { to: '/purchases/debit-notes', label: 'nav.debitNotes', icon: FilePlus, section: 'purchases', order: 20, perm: 'ap.debits.read', app: 'ap' },
    { to: '/suppliers', label: 'nav.suppliers', icon: Truck, section: 'purchases', order: 30, perm: 'ap.suppliers.read', app: 'ap' },
  ],
  routes: [
    ...documentRoutes('purchase_bill'),
    ...documentRoutes('purchase_credit'),
    { path: '/suppliers', element: <PartyList key="s" kind="supplier" /> },
    { path: '/suppliers/:id', element: <PartyView key="sv" kind="supplier" /> },
    { path: '/reports/aging/payable', element: <AgingPage key="ap" type="payable" /> },
    { path: '/documents/:id', element: <DocumentRedirect /> },
  ],
  commands: [
    { id: 'new-bill', label: 'docs.purchase_bill.new', icon: ReceiptText, group: 'create', to: '/purchases/bills/new', perm: 'ap.bills.write', app: 'ap', keywords: 'bill purchase شراء' },
    { id: 'new-debit', label: 'docs.purchase_credit.new', icon: FilePlus, group: 'create', to: '/purchases/debit-notes/new', perm: 'ap.debits.write', app: 'ap', keywords: 'debit return مرتجع' },
    { id: 'go-bills', label: 'nav.bills', icon: ReceiptText, group: 'navigate', to: '/purchases/bills', perm: 'ap.bills.read', app: 'ap', keywords: 'purchases مشتريات' },
    { id: 'go-suppliers', label: 'nav.suppliers', icon: Truck, group: 'navigate', to: '/suppliers', perm: 'ap.suppliers.read', app: 'ap', keywords: 'vendors موردين' },
    { id: 'go-aging-ap', label: 'reports.agingPayable', icon: Clock, group: 'navigate', to: '/reports/aging/payable', perm: 'ap.reports.read', app: 'ap', keywords: 'أعمار مستحقات موردين' },
  ],
  reports: [
    { to: '/reports/aging/payable', group: 'reports.groups.parties', title: 'reports.agingPayable', desc: 'reports.agingDesc', icon: Clock, color: 'var(--line-amber)', perm: 'ap.reports.read', app: 'ap' },
  ],
  slots: { 'dashboard.widgets': () => <SideOverview side="purchases" /> },
};
