import { Clock, FileMinus, FileText, Users } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { documentRoutes, DocumentRedirect } from '../../engines/documents';
import { SideOverview } from '../../engines/documents/Overview';
import { PartyList, PartyView } from '../../engines/parties';
import { AgingPage } from '../../engines/parties/Aging';

/**
 * Accounts Receivable (like SAP FI-AR): customers, sales invoices, credit
 * notes and customer ageing, built on the shared billing and partner engines.
 */
export const arModule: WebModule = {
  id: 'ar',
  nav: [
    { to: '/sales/invoices', label: 'nav.invoices', icon: FileText, section: 'sales', order: 10, perm: 'ar.invoices.read', app: 'ar' },
    { to: '/sales/credit-notes', label: 'nav.creditNotes', icon: FileMinus, section: 'sales', order: 20, perm: 'ar.credits.read', app: 'ar' },
    { to: '/customers', label: 'nav.customers', icon: Users, section: 'sales', order: 30, perm: 'ar.customers.read', app: 'ar' },
  ],
  routes: [
    ...documentRoutes('sales_invoice'),
    ...documentRoutes('sales_credit'),
    { path: '/customers', element: <PartyList key="c" kind="customer" /> },
    { path: '/customers/:id', element: <PartyView key="cv" kind="customer" /> },
    { path: '/reports/aging/receivable', element: <AgingPage key="ar" type="receivable" /> },
    // Journal lines link to /documents/:id whatever the kind; AR owns the redirect when installed.
    { path: '/documents/:id', element: <DocumentRedirect /> },
  ],
  commands: [
    { id: 'new-invoice', label: 'docs.sales_invoice.new', icon: FileText, group: 'create', to: '/sales/invoices/new', perm: 'ar.invoices.write', app: 'ar', keywords: 'invoice فاتورة بيع' },
    { id: 'new-credit', label: 'docs.sales_credit.new', icon: FileMinus, group: 'create', to: '/sales/credit-notes/new', perm: 'ar.credits.write', app: 'ar', keywords: 'return credit مرتجع' },
    { id: 'go-invoices', label: 'nav.invoices', icon: FileText, group: 'navigate', to: '/sales/invoices', perm: 'ar.invoices.read', app: 'ar', keywords: 'sales مبيعات' },
    { id: 'go-customers', label: 'nav.customers', icon: Users, group: 'navigate', to: '/customers', perm: 'ar.customers.read', app: 'ar', keywords: 'clients عملاء' },
    { id: 'go-aging-ar', label: 'reports.agingReceivable', icon: Clock, group: 'navigate', to: '/reports/aging/receivable', perm: 'ar.reports.read', app: 'ar', keywords: 'أعمار ديون عملاء' },
  ],
  reports: [
    { to: '/reports/aging/receivable', group: 'reports.groups.parties', title: 'reports.agingReceivable', desc: 'reports.agingDesc', icon: Clock, color: 'var(--line-pink)', perm: 'ar.reports.read', app: 'ar' },
  ],
  slots: { 'dashboard.widgets': () => <SideOverview side="sales" /> },
};
