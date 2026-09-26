import type { WebModule } from '../core/registry';
import { dashboardModule } from './dashboard';
import { documentsModule } from './documents';
import { paymentsModule } from './payments';
import { partiesModule } from './parties';
import { accountsModule } from './accounts';
import { journalModule } from './journal';
import { catalogModule } from './catalog';
import { reportsModule } from './reports';
import { settingsModule } from './settings';

/**
 * Installed web modules. Each one contributes its own navigation, pages and
 * command-palette actions; the shell simply composes them.
 */
export const webModules: WebModule[] = [
  dashboardModule,
  documentsModule,
  partiesModule,
  paymentsModule,
  accountsModule,
  journalModule,
  catalogModule,
  reportsModule,
  settingsModule,
];
