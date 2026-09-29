import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { lanUrls } from './modules/system/index.js';
import type { EcoInternal } from './modules/eco/service.js';

// Works from src/ (tsx) and dist/ (compiled): both sit two levels below the repository root.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const builtWeb = resolve(root, 'apps/web/dist');
const config = loadConfig({ dataDir: resolve(root, 'data'), webDir: existsSync(builtWeb) ? builtWeb : null });

const { http, kernel } = await buildApp(config);
await http.listen({ host: config.host, port: config.port });

// Daily automatic backups, keeping the last 14.
const backup = kernel.services.get('backup');
const autoBackup = () => {
  try {
    if (kernel.services.get('settings').isSetupComplete()) {
      backup.create('auto');
      backup.prune(14);
    }
  } catch (err) {
    http.log.error(err, 'automatic backup failed');
  }
};
setTimeout(autoBackup, 60_000).unref();
setInterval(autoBackup, 24 * 3_600_000).unref();

// Peers (GMES …): push our feed and pull theirs every minute; a failure is recorded on the peer, never thrown.
const eco = kernel.services.has('eco') ? (kernel.services.get('eco') as EcoInternal) : null;
if (eco) {
  const syncPeers = () => {
    try {
      if (kernel.services.get('settings').isSetupComplete() && kernel.apps.isEnabled('eco') && eco.peers.list().length) void eco.peers.syncAll();
    } catch (err) {
      http.log.error(err, 'peer synchronisation failed');
    }
  };
  // Publish what changed while this version was not running (first start, restored backup, app switched off); daily after that.
  const resync = () => {
    try {
      if (kernel.services.get('settings').isSetupComplete() && kernel.apps.isEnabled('eco')) eco.resync();
    } catch (err) {
      http.log.error(err, 'integration resync failed');
    }
  };
  resync();
  setInterval(resync, 24 * 3_600_000).unref();
  setTimeout(syncPeers, 15_000).unref();
  setInterval(syncPeers, 60_000).unref();
}

const line = '─'.repeat(52);
console.log(`\n${line}\n  Mizan accounting is running\n`);
console.log(`  This computer:   http://localhost:${config.port}`);
for (const u of lanUrls(config.port)) console.log(`  Other computers: ${u}`);
console.log(`\n  Data file: ${config.dbFile}\n${line}\n`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await http.close();
    process.exit(0);
  });
}
