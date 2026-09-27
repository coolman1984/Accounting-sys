import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
