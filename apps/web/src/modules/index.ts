import type { WebModule } from '../core/registry';
import { dashboardModule } from './dashboard';
import { glModule } from './gl';
import { taxModule } from './tax';
import { arModule } from './ar';
import { apModule } from './ap';
import { treasuryModule } from './treasury';
import { coModule } from './co';
import { fxModule } from './fx';
import { analysisModule } from './analysis';
import { budgetModule } from './budget';
import { cashflowModule } from './cashflow';
import { manufacturingModule } from './manufacturing';
import { assetsModule } from './assets';
import { payrollModule } from './payroll';
import { chequesModule } from './cheques';
import { recurringModule } from './recurring';
import { importsModule } from './imports';
import { einvoiceModule } from './einvoice';
import { catalogModule } from './catalog';
import { inventoryModule } from './inventory';
import { purchasingModule } from './purchasing';
import { pricingModule } from './pricing';
import { adminModule } from './admin';

/**
 * Installed web modules — the edition's list. Each one contributes its own
 * navigation, pages, commands, report tiles and home-page cards; the shell
 * composes them. A module imports only core/, ui/ and engines/ (checked by
 * the boundary test), so removing one is deleting its folder and its line here.
 */
export const webModules: WebModule[] = [
  dashboardModule,
  glModule,
  taxModule,
  arModule,
  apModule,
  treasuryModule,
  coModule,
  fxModule,
  analysisModule,
  budgetModule,
  cashflowModule,
  manufacturingModule,
  assetsModule,
  payrollModule,
  chequesModule,
  recurringModule,
  einvoiceModule,
  catalogModule,
  inventoryModule,
  purchasingModule,
  pricingModule,
  importsModule,
  adminModule,
];
