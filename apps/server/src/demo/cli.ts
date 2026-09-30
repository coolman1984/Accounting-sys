import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { hashPassword } from '../modules/system/auth.js';
import { DEMO_ADMIN, seedHorizonElectronics } from './horizon-electronics.js';

const DEV_PASSWORD = '123';

/**
 * npm run demo [-- --data <folder>]
 * Builds the demo company in its own data folder (default: data-demo next to data). It never touches an
 * existing company: if the folder already holds a database it stops and says so.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const arg = process.argv.indexOf('--data');
const dataDir = resolve(arg > 0 ? process.argv[arg + 1] : process.env.MIZAN_DATA_DIR ?? resolve(root, 'data-demo'));
const config = loadConfig({ dataDir, webDir: null, logLevel: 'warn' });

if (existsSync(config.dbFile)) {
  console.error(`\n  ${config.dbFile} already exists — the demo is built only into an empty folder.`);
  console.error('  Delete that folder yourself (or pass --data <another folder>) and run again.\n');
  process.exit(1);
}

const started = Date.now();
const app = await buildApp(config);
try {
  const s = await seedHorizonElectronics(app, (msg) => console.log('  ·', msg));
  // Development sign-in admin / 123 (shorter than the app allows, so it is written directly).
  app.kernel.db.run('UPDATE users SET password_hash = ? WHERE username = ?', [hashPassword(DEV_PASSWORD), DEMO_ADMIN.username]);
  app.kernel.services.get('backup').create('demo');
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  Demo company ready in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(`  ${s.documents} documents, ${s.payments} receipts/payments/cheques, ${s.productionOrders} production orders,`);
  console.log(`  ${s.employees} employees, ${s.journals} journal entries`);
  console.log(`\n  Data file: ${config.dbFile}`);
  console.log(`  Sign in:   ${DEMO_ADMIN.username} / ${DEV_PASSWORD}  (development only)`);
  console.log(`  Start it:  start-demo.bat  (http://localhost:4810)\n${line}\n`);
} finally {
  await app.http.close();
}
