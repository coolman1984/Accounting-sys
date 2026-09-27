import type { AppModule } from '../../kernel/modules.js';

/**
 * Accounts Payable (like SAP FI-AP): suppliers, bills and debit notes,
 * supplier ageing — plugged into the billing engine with its own permissions.
 */
export const apModule: AppModule = {
  id: 'ap',
  dependsOn: ['documents', 'parties', 'catalog'],
  permissions: [
    'ap.suppliers.read',
    'ap.suppliers.write',
    'ap.bills.read',
    'ap.bills.write',
    'ap.bills.post',
    'ap.debits.read',
    'ap.debits.write',
    'ap.debits.post',
    'ap.reports.read',
  ],
  apps: [{ id: 'ap', order: 20, permissions: ['ap', 'catalog'] }],
  roles: [
    {
      id: 'payables_accountant',
      permissions: ['ap.*', 'catalog.items.read', 'treasury.payments.*', 'tax.codes.read'],
    },
  ],

  setup({ services }) {
    const docs = services.get('documents');
    docs.registerKind('purchase_bill', { perm: 'ap.bills' });
    docs.registerKind('purchase_credit', { perm: 'ap.debits' });
    docs.registerSide('purchases', { reportPerm: 'ap.reports.read' });
    services.get('parties').registerRole('supplier', { perm: 'ap.suppliers' });
  },
};
