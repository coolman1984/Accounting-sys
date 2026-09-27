import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Architecture fitness test — the "mechano" rule:
 * a module may import only from kernel/, contracts/, the core modules
 * (system, ledger — shipped in every edition) and its own folder.
 * Anything else would make the module impossible to remove.
 */
const SRC = resolve(import.meta.dirname, '..');
const CORE = new Set(['system', 'ledger']);

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

test('modules only talk to each other through kernel and contracts', () => {
  const offences: string[] = [];
  const modulesDir = join(SRC, 'modules');
  for (const file of files(modulesDir)) {
    const rel = relative(modulesDir, file);
    if (!rel.includes(sep)) continue; // modules/index.ts is the edition's list, allowed to import all
    const own = rel.split(sep)[0];
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(join(file, '..'), m[1]);
      const inside = relative(modulesDir, target);
      if (inside.startsWith('..')) {
        const top = relative(SRC, target).split(sep)[0];
        if (top !== 'kernel' && top !== 'contracts') offences.push(`${rel} → ${m[1]}`);
        continue;
      }
      const other = inside.split(sep)[0];
      if (other !== own && !CORE.has(other)) offences.push(`${rel} → ${m[1]}`);
    }
  }
  assert.deepEqual(offences, [], 'cross-module imports (use a contract, an event or a service):\n' + offences.join('\n'));
});

test('contracts are types and constants only — no module code', () => {
  for (const file of files(join(SRC, 'contracts'))) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/from\s+['"]\.\.\/modules/.test(text), `${relative(SRC, file)} imports a module`);
  }
});

/**
 * The same rule for the web app: a module folder imports only core/, ui/,
 * engines/, lib/, styles/ and itself; engines and ui never reach into modules.
 */
const WEB = resolve(SRC, '../../web/src');
const webFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? webFiles(p) : /\.tsx?$/.test(p) ? [p] : [];
  });

test('web modules only use core, ui and engines', { skip: !existsSync(WEB) }, () => {
  const offences: string[] = [];
  for (const file of webFiles(WEB)) {
    const rel = relative(WEB, file);
    const [top, own] = rel.split(sep);
    if (rel === join('modules', 'index.ts')) continue; // the edition's list
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/g)) {
      const [ttop, town] = relative(WEB, resolve(join(file, '..'), m[1])).split(sep);
      const bad =
        (top === 'modules' && ttop === 'modules' && town !== own) ||
        ((top === 'engines' || top === 'ui' || top === 'core') && ttop === 'modules') ||
        ((top === 'ui' || top === 'core') && ttop === 'engines');
      if (bad) offences.push(`${rel} → ${m[1]}`);
    }
  }
  assert.deepEqual(offences, [], 'web cross-module imports:\n' + offences.join('\n'));
});

test('every module folder belongs to an app in the edition map', { skip: !existsSync(join(SRC, '../../../scripts/edition.mjs')) }, async () => {
  const { APPS } = await import(join(SRC, '../../../scripts/edition.mjs'));
  const engines = new Set(['parties', 'catalog', 'documents']); // pulled in through dependsOn
  const mapped = { server: new Set<string>(engines), web: new Set<string>() };
  for (const a of Object.values(APPS) as { server: string[]; web: string[] }[]) {
    a.server.forEach((m) => mapped.server.add(m));
    a.web.forEach((m) => mapped.web.add(m));
  }
  const dirs = (d: string) => readdirSync(d).filter((f) => statSync(join(d, f)).isDirectory());
  assert.deepEqual(dirs(join(SRC, 'modules')).filter((m) => !mapped.server.has(m)), [], 'server modules missing from scripts/edition.mjs');
  if (existsSync(WEB)) assert.deepEqual(dirs(join(WEB, 'modules')).filter((m) => !mapped.web.has(m)), [], 'web modules missing from scripts/edition.mjs');
});
