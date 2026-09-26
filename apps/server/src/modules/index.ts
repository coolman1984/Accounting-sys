import type { AppModule } from '../kernel/modules.js';
import { systemModule } from './system/index.js';
import { ledgerModule } from './ledger/index.js';
import { partiesModule } from './parties/index.js';
import { catalogModule } from './catalog/index.js';
import { documentsModule } from './documents/index.js';
import { paymentsModule } from './payments/index.js';
import { reportsModule } from './reports/index.js';

/**
 * The installed modules. Order does not matter — the kernel sorts them by
 * `dependsOn`. To add a feature (inventory, payroll, fixed assets …), write a
 * module and list it here.
 */
export const modules: AppModule[] = [
  systemModule,
  ledgerModule,
  partiesModule,
  catalogModule,
  documentsModule,
  paymentsModule,
  reportsModule,
];
