import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createKernel } from './kernel/kernel.js';
import { modules } from './modules/index.js';
import { createKey, listKeys, revokeKey } from './modules/eco/keys.js';
import type { EcoInternal } from './modules/eco/service.js';

/**
 * npm run eco -- <command>      (on the server computer, with the data folder of the company)
 *
 *   company                         show the company id and the event source
 *   key list                        list machine keys (never the keys themselves)
 *   key create <name> <scope> …     create a key for another application; it is printed ONCE
 *                                   scopes: eco.feed.read eco.inbox.write eco.acks.write eco.events.read (or eco.*)
 *   key revoke <name>               revoke a key
 *   resync                          publish every snapshot that differs from the last one sent
 *
 * Options: --data <folder> (default: MIZAN_DATA_DIR or the repository's data folder).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const at = argv.indexOf('--data');
const dataDir = at >= 0 ? resolve(argv[at + 1]) : undefined;
const args = at >= 0 ? argv.filter((_, i) => i !== at && i !== at + 1) : argv;

const kernel = createKernel(loadConfig({ dataDir: dataDir ?? resolve(root, 'data'), webDir: null, logLevel: 'silent' }), modules);
const eco = kernel.services.get('eco') as EcoInternal;
const audit = kernel.services.get('audit');
const say = (s: string) => process.stdout.write(s + '\n');

try {
  const [cmd, sub, ...rest] = args;
  if (cmd === 'company') {
    say(`company id: ${eco.companyId()}`);
    say(`source:     ${eco.source()}`);
  } else if (cmd === 'key' && sub === 'list') {
    for (const k of listKeys(kernel.db)) say(`${k.active ? 'active ' : 'revoked'}  ${k.name.padEnd(24)} ${k.scopes.join(' ')}  (${k.created_at})`);
  } else if (cmd === 'key' && sub === 'create') {
    const [name, ...scopes] = rest;
    if (!name || !scopes.length) throw new Error('usage: key create <name> <scope> [<scope> …]');
    const k = kernel.db.tx(() => {
      const created = createKey(kernel.db, { name, scopes }, null);
      audit.log({ userId: null, action: 'create', entity: 'eco_key', entityId: created.id, summary: `${name}: ${scopes.join(' ')} (command line)` });
      return created;
    });
    say(`key for ${k.name} (shown once — store it in the other application now):`);
    say(k.key);
  } else if (cmd === 'key' && sub === 'revoke') {
    const row = listKeys(kernel.db).find((k) => k.name === rest[0]);
    if (!row) throw new Error(`no key named ${rest[0]}`);
    kernel.db.tx(() => {
      revokeKey(kernel.db, row.id);
      audit.log({ userId: null, action: 'revoke', entity: 'eco_key', entityId: row.id, summary: `${row.name} (command line)` });
    });
    say(`revoked ${row.name}`);
  } else if (cmd === 'resync') {
    say(`published ${eco.resync()} snapshots`);
  } else {
    say('commands: company | key list | key create <name> <scope…> | key revoke <name> | resync   [--data <folder>]');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exitCode = 1;
} finally {
  kernel.close();
}
