import type { AppModule } from '../kernel/modules.js';
import { systemModule } from './system/index.js';
import { ledgerModule } from './ledger/index.js';
import { partiesModule } from './parties/index.js';
import { catalogModule } from './catalog/index.js';
import { documentsModule } from './documents/index.js';
import { paymentsModule } from './payments/index.js';
import { taxModule } from './tax/index.js';
import { arModule } from './ar/index.js';
import { apModule } from './ap/index.js';
import { coModule } from './co/index.js';
import { inventoryModule } from './inventory/index.js';
import { purchasingModule } from './purchasing/index.js';
import { pricingModule } from './pricing/index.js';

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
  inventoryModule,
  purchasingModule,
  pricingModule,
  taxModule,
  arModule,
  apModule,
  coModule,
];
