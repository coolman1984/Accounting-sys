import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

/**
 * Edition smoke test — uses only the core (system + ledger), so it runs in
 * every edition built by `scripts/edition.mjs`, whatever apps it contains.
 */
describe('edition smoke test', () => {
  let c: TestClient;
  before(async () => {
    c = await setupCompany();
  });
  after(() => c.close());

  test('the expected apps are installed and switched on', async () => {
    const apps: { id: string; enabled: boolean }[] = await c.get('/api/system/apps');
    const ids = apps.map((a) => a.id);
    const expected = process.env.MIZAN_EDITION_APPS?.split(',');
    if (expected) assert.deepEqual([...ids].sort(), [...expected].sort());
    assert.ok(apps.every((a) => a.enabled), 'a fresh company starts with every installed app on');
  });

  test('the ledger books, balances and every health check passes', async () => {
    const cash = await acc(c, '1110');
    const rent = await acc(c, '5220');
    await c.post('/api/journal', { date: '2026-02-01', memo: 'Rent', post: true, lines: [{ accountId: rent, debit: 5000 }, { accountId: cash, credit: 5000 }] });
    assert.equal((await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).balanced, true);
    const health = await c.get('/api/system/health');
    const bad = health.flatMap((m: any) => m.checks.filter((x: any) => !x.ok && x.severity !== 'warning').map((x: any) => `${m.module}.${x.id}`));
    assert.deepEqual(bad, []);
  });

  test('every role template names only rights that exist in this edition', async () => {
    const cat = await c.get('/api/permissions');
    const all = new Set(cat.modules.flatMap((m: any) => m.permissions));
    for (const t of cat.templates) for (const p of t.permissions) assert.ok(all.has(p), `${t.id}: ${p}`);
  });
});
