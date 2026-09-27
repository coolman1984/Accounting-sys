import type { AppModule } from '../../kernel/modules.js';

/**
 * Accounts Receivable (like SAP FI-AR): customers, sales invoices and credit
 * notes, customer ageing. The billing engine (documents) and the partner
 * master (parties) do the work; this module sells it — it plugs the sales
 * kinds and the customer role in, with their own permissions.
 */
export const arModule: AppModule = {
  id: 'ar',
  dependsOn: ['documents', 'parties', 'catalog'],
  permissions: [
    'ar.customers.read',
    'ar.customers.write',
    'ar.invoices.read',
    'ar.invoices.write',
    'ar.invoices.post',
    'ar.credits.read',
    'ar.credits.write',
    'ar.credits.post',
    'ar.reports.read',
  ],
  apps: [{ id: 'ar', order: 10, permissions: ['ar', 'catalog'] }],
  roles: [
    {
      id: 'sales_clerk',
      permissions: ['ar.customers.read', 'ar.customers.write', 'ar.invoices.read', 'ar.invoices.write', 'ar.credits.read', 'catalog.items.read', 'pricing.lists.read', 'inventory.stock.read'],
    },
    {
      id: 'receivables_accountant',
      permissions: ['ar.*', 'catalog.items.read', 'treasury.receipts.*', 'tax.codes.read'],
    },
  ],

  setup({ services }) {
    const docs = services.get('documents');
    docs.registerKind('sales_invoice', { perm: 'ar.invoices' });
    docs.registerKind('sales_credit', { perm: 'ar.credits' });
    docs.registerSide('sales', { reportPerm: 'ar.reports.read' });
    services.get('parties').registerRole('customer', { perm: 'ar.customers' });
  },
};
