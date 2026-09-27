import type { WebModule } from '../core/registry';
import { dashboardModule } from './dashboard';
import { documentsModule } from './documents';
import { paymentsModule } from './payments';
import { partiesModule } from './parties';
import { accountsModule } from './accounts';
import { journalModule } from './journal';
import { catalogModule } from './catalog';
import { inventoryModule } from './inventory';
import { purchasingModule } from './purchasing';
import { pricingModule } from './pricing';
import { reportsModule } from './reports';
import { settingsModule } from './settings';
import { systemModule } from './system';

/**
 * Installed web modules. Each one contributes its own navigation, pages and
 * command-palette actions; the shell simply composes them.
 */
export const webModules: WebModule[] = [
  dashboardModule,
  documentsModule,
  partiesModule,
  inventoryModule,
  purchasingModule,
  pricingModule,
  paymentsModule,
  accountsModule,
  journalModule,
  catalogModule,
  reportsModule,
  settingsModule,
  systemModule,
];
