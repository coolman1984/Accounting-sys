import type { WebModule } from '../../core/registry';
import { accountsModule } from './accounts';
import { journalModule } from './journal';
import { reportsModule } from './reports';

/**
 * General Ledger (core, like SAP FI-GL): chart of accounts, journal entries,
 * financial statements and the reports hub. Every edition ships it.
 */
export const glModule: WebModule = {
  id: 'gl',
  nav: [...(accountsModule.nav ?? []), ...(journalModule.nav ?? []), ...(reportsModule.nav ?? [])],
  routes: [...accountsModule.routes, ...journalModule.routes, ...reportsModule.routes],
  commands: [...(accountsModule.commands ?? []), ...(journalModule.commands ?? []), ...(reportsModule.commands ?? [])],
};
