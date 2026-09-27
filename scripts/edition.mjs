#!/usr/bin/env node
/**
 * Build an *edition* — a copy of Mizan that contains only the apps a customer bought.
 *
 *   node scripts/edition.mjs gl,ar,treasury            → ../mizan-edition-gl-ar-treasury
 *   node scripts/edition.mjs finance --out /tmp/x      → a preset (see PRESETS)
 *   node scripts/edition.mjs ap,purchasing --check     → also typecheck + run the edition tests
 *   node scripts/edition.mjs --list                    → show apps and presets
 *
 * How it works (the "mechano" rule makes this possible):
 *   1. each app maps to server modules and web modules (APPS below);
 *   2. server `dependsOn` is read from the code, so needed engines come along;
 *   3. unwanted module folders are simply not copied, and both module lists
 *      (server `modules/index.ts`, web `modules/index.ts`) are rewritten;
 *   4. tests that exercise removed apps are dropped; the boundary and edition
 *      smoke tests stay.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SERVER_MODULES = join(ROOT, 'apps/server/src/modules');
const WEB_MODULES = join(ROOT, 'apps/web/src/modules');

/** App id → server modules, web modules and the apps it needs. Keep in step with the app manifests. */
export const APPS = {
  gl: { server: ['system', 'ledger'], web: ['auth', 'dashboard', 'gl', 'admin'], requires: [] },
  ar: { server: ['ar'], web: ['ar', 'catalog'], requires: [] },
  ap: { server: ['ap'], web: ['ap', 'catalog'], requires: [] },
  treasury: { server: ['payments', 'bank'], web: ['treasury'], requires: [] },
  tax: { server: ['tax'], web: ['tax'], requires: [] },
  co: { server: ['co'], web: ['co'], requires: [] },
  fx: { server: ['fx'], web: ['fx'], requires: [] },
  analysis: { server: ['analysis'], web: ['analysis'], requires: [] },
  budget: { server: ['budget'], web: ['budget'], requires: [] },
  cashflow: { server: ['cashflow'], web: ['cashflow'], requires: [] },
  mfg: { server: ['manufacturing'], web: ['manufacturing'], requires: ['inventory'] },
  assets: { server: ['assets'], web: ['assets'], requires: [] },
  payroll: { server: ['payroll'], web: ['payroll'], requires: [] },
  cheques: { server: ['cheques'], web: ['cheques'], requires: [] },
  inventory: { server: ['inventory'], web: ['inventory', 'catalog'], requires: [] },
  purchasing: { server: ['purchasing'], web: ['purchasing'], requires: ['ap'] },
  pricing: { server: ['pricing'], web: ['pricing'], requires: ['ar'] },
};
export const PRESETS = {
  ledger: ['gl'],
  finance: ['gl', 'ar', 'ap', 'treasury', 'tax', 'fx'],
  trade: ['gl', 'ar', 'ap', 'treasury', 'tax', 'fx', 'inventory', 'purchasing', 'pricing', 'analysis', 'budget', 'cashflow'],
  full: Object.keys(APPS),
};
/** Tests that only use the always-present parts. */
const EDITION_TESTS = ['boundaries.test.ts', 'edition.test.ts', 'helpers.ts'];

const dependsOn = (mod) => {
  const text = readFileSync(join(SERVER_MODULES, mod, 'index.ts'), 'utf8');
  const m = text.match(/dependsOn:\s*\[([^\]]*)\]/);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
};

export function resolveEdition(requested) {
  const apps = new Set(['gl']);
  const add = (a) => {
    if (!APPS[a]) throw new Error(`Unknown app "${a}". Known: ${Object.keys(APPS).join(', ')}`);
    if (apps.has(a) && a !== 'gl') return;
    apps.add(a);
    APPS[a].requires.forEach(add);
  };
  requested.forEach(add);
  const server = new Set();
  const addMod = (m) => {
    if (server.has(m)) return;
    server.add(m);
    dependsOn(m).forEach(addMod);
  };
  for (const a of apps) APPS[a].server.forEach(addMod);
  const web = new Set([...apps].flatMap((a) => APPS[a].web));
  if (server.has('catalog')) web.add('catalog');
  return { apps: [...apps], server: [...server], web: [...web] };
}

/** Keep only the import lines and array entries whose module folder is wanted. */
function rewriteIndex(file, keep, re) {
  const text = readFileSync(file, 'utf8');
  const dropped = new Set();
  const lines = text.split('\n').filter((l) => {
    const m = l.match(re);
    if (m && !keep.has(m[2])) {
      dropped.add(m[1]);
      return false;
    }
    return true;
  });
  const out = lines.filter((l) => !dropped.has(l.trim().replace(/,$/, ''))).join('\n');
  writeFileSync(file, out);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list') || args.length === 0) {
    console.log('Apps:    ', Object.keys(APPS).join(', '));
    for (const [k, v] of Object.entries(PRESETS)) console.log(`Preset ${k.padEnd(8)}`, v.join(', '));
    return;
  }
  const spec = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
  const requested = PRESETS[spec] ?? spec.split(',').map((s) => s.trim()).filter(Boolean);
  const ed = resolveEdition(requested);
  const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const out = resolve(outArg ?? join(ROOT, '..', `mizan-edition-${ed.apps.join('-')}`));
  console.log(`Apps:           ${ed.apps.join(', ')}`);
  console.log(`Server modules: ${ed.server.join(', ')}`);
  console.log(`Web modules:    ${ed.web.join(', ')}`);

  if (existsSync(out)) rmSync(out, { recursive: true });
  const tracked = execSync('git ls-files -co --exclude-standard', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const skip = (p) => {
    let m = p.match(/^apps\/server\/src\/modules\/([^/]+)\//);
    if (m) return !ed.server.includes(m[1]);
    m = p.match(/^apps\/web\/src\/modules\/([^/]+)\//);
    if (m) return !ed.web.includes(m[1]);
    m = p.match(/^apps\/server\/src\/test\/([^/]+)$/);
    if (m) return !EDITION_TESTS.includes(m[1]);
    return false;
  };
  for (const p of tracked) {
    if (skip(p) || !existsSync(join(ROOT, p))) continue;
    mkdirSync(dirname(join(out, p)), { recursive: true });
    cpSync(join(ROOT, p), join(out, p));
  }
  rewriteIndex(join(out, 'apps/server/src/modules/index.ts'), new Set(ed.server), /^import \{ (\w+) \} from '\.\/([\w-]+)\/index\.js';/);
  rewriteIndex(join(out, 'apps/web/src/modules/index.ts'), new Set(ed.web), /^import \{ (\w+) \} from '\.\/([\w-]+)';/);
  writeFileSync(join(out, 'EDITION.json'), JSON.stringify({ apps: ed.apps, serverModules: ed.server, webModules: ed.web, from: execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim() }, null, 2) + '\n');
  console.log(`Written to      ${out}`);

  if (args.includes('--check')) {
    // Reuse the installed packages instead of downloading them again.
    for (const nm of ['node_modules', 'apps/server/node_modules', 'apps/web/node_modules']) {
      if (existsSync(join(ROOT, nm)) && !existsSync(join(out, nm))) symlinkSync(join(ROOT, nm), join(out, nm), 'dir');
    }
    const run = (cmd) => execSync(cmd, { cwd: out, stdio: 'inherit', env: { ...process.env, MIZAN_EDITION_APPS: ed.apps.join(',') } });
    run('npm run typecheck --silent');
    run('npm test --silent');
    console.log('Edition checks passed ✔');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
