import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { currentDate, nowIso, nowMs, setClock, today } from '../kernel/dates.js';
import { modules } from '../modules/index.js';

/** The injectable clock (plan 10-MIZAN WP-M7): the scenario engine drives 90 simulated days through it. */
const SRC = resolve(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

test('without a clock the server reads real time; with one, every date helper follows it', () => {
  setClock();
  assert.ok(Math.abs(nowMs() - Date.now()) < 1000);
  let now = new Date('2026-03-15T09:30:00.000Z');
  setClock({ now: () => now });
  assert.equal(nowIso(), '2026-03-15T09:30:00.000Z');
  assert.equal(nowMs(), now.getTime());
  assert.equal(currentDate().getTime(), now.getTime());
  assert.match(today(), /^2026-03-1[45]$/); // the local calendar day of that instant
  now = new Date('2026-04-02T12:00:00.000Z');
  assert.equal(today(), '2026-04-02');
  setClock();
});

test('buildApp installs the clock it is given, and a later app without one goes back to real time', async () => {
  const config = loadConfig({ dbFile: ':memory:', dataDir: '/tmp/mizan-test', logLevel: 'silent', webDir: null });
  const fixed = new Date('2026-06-10T12:00:00.000Z');
  const a = await buildApp(config, modules, { clock: { now: () => fixed } });
  assert.equal(today(), '2026-06-10');
  await a.http.close();
  const b = await buildApp(config, modules);
  assert.ok(Math.abs(nowMs() - Date.now()) < 1000);
  await b.http.close();
});

test('a session made on a simulated day is valid on that day and gone after its hours', async () => {
  const config = loadConfig({ dbFile: ':memory:', dataDir: '/tmp/mizan-test', logLevel: 'silent', webDir: null });
  let now = new Date('2026-01-05T08:00:00.000Z');
  const app = await buildApp(config, modules, { clock: { now: () => now } });
  const setup = await app.http.inject({ method: 'POST', url: '/api/setup', payload: {
    company: { name: 'Clock Co', baseCurrency: 'EGP', moneyScale: 2 }, fiscalYearStart: '2026-01-01',
    admin: { username: 'admin', displayName: 'Admin', password: 'password123' }, locale: 'en', seedChartOfAccounts: true, vatRateBp: 1400 } });
  assert.equal(setup.statusCode, 200);
  const login = await app.http.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'password123' } });
  const cookie = `mizan_sid=${login.cookies.find((c) => c.name === 'mizan_sid')!.value}`;
  const me = () => app.http.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal((await me()).statusCode, 200);
  now = new Date('2026-01-05T09:00:00.000Z');
  assert.equal((await me()).statusCode, 200);
  now = new Date('2026-03-01T09:00:00.000Z'); // two months later: the session has expired on the simulated clock
  assert.equal((await me()).statusCode, 401);
  await app.http.close();
  setClock();
});

test('server modules never read the machine clock directly (use kernel/dates.ts)', () => {
  const offences: string[] = [];
  for (const file of files(join(SRC, 'modules'))) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/\bnew Date\(\s*\)|\bDate\.now\(\)/.test(line)) offences.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offences, [], 'raw clock reads in modules (use today(), nowIso(), nowMs() or currentDate()):\n' + offences.join('\n'));
});
