import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { DEMO_ADMIN, DEMO_TO, seedSamsungEgypt, type DemoSummary } from '../demo/samsung-egypt.js';

/**
 * The demo company (npm run demo) is shown to accountants who will look for mistakes: every
 * statement must tie. It is built here in memory through the same code, then checked.
 */
describe('demo company: Samsung Electronics Egypt factory', () => {
  let app: App;
  let summary: DemoSummary;
  let cookie = '';
  const get = async (url: string) => {
    const res = await app.http.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
    return JSON.parse(res.body);
  };

  before(async () => {
    app = await buildApp(loadConfig({ dbFile: ':memory:', dataDir: '/tmp/mizan-test', logLevel: 'silent', webDir: null }));
    summary = await seedSamsungEgypt(app);
    const res = await app.http.inject({ method: 'POST', url: '/api/auth/login', payload: { username: DEMO_ADMIN.username, password: DEMO_ADMIN.password } });
    cookie = `mizan_sid=${res.cookies.find((x) => x.name === 'mizan_sid')!.value}`;
  });
  after(() => app.http.close());

  test('it is big: hundreds of documents over nine months', () => {
    assert.ok(summary.documents > 250, `${summary.documents} documents`);
    assert.ok(summary.payments > 200);
    assert.equal(summary.productionOrders, 90);
    assert.ok(summary.employees > 100);
  });

  test('the books balance and every health check passes (backups aside)', async () => {
    const tb = await get(`/api/reports/trial-balance?from=2026-01-01&to=${DEMO_TO}`);
    assert.equal(tb.balanced, true);
    const failed = (await get('/api/system/health')).flatMap((m: any) => m.checks.filter((c: any) => !c.ok && c.id !== 'backup').map((c: any) => `${m.module}.${c.id}`));
    assert.deepEqual(failed, []);
  });

  test('sub-ledgers tie to the ledger: stock, withholding, opening clearing account', async () => {
    const tb = await get(`/api/reports/trial-balance?from=2026-01-01&to=${DEMO_TO}`);
    const bal = (code: string) => { const r = tb.rows.find((x: any) => x.code === code); return r ? r.closing_debit - r.closing_credit : 0; };
    const valuation = await get(`/api/inventory/reports/valuation?asOf=${DEMO_TO}`);
    assert.equal(valuation.rows.reduce((s: number, r: any) => s + r.value, 0), bal('1140'), 'stock valuation = inventory account');
    const wht = await get(`/api/reports/withholding?from=2026-01-01&to=${DEMO_TO}&side=deducted`);
    assert.equal(wht.ledger.balance, -bal('2190'));
    assert.equal(bal('3900'), 0, 'the opening clearing account is empty');
    assert.equal(bal('2160'), 0, 'no goods received without an invoice');
    for (const code of ['1110', '1120', '1121', '1126']) assert.ok(bal(code) >= 0, `cash account ${code} is not overdrawn`);
  });

  test('the balance sheet balances and the year is profitable', async () => {
    const bs = await get(`/api/reports/balance-sheet?asOf=${DEMO_TO}`);
    const t = bs.totals;
    assert.equal(t.assets, t.liabilities + t.equity, JSON.stringify(t));
    const is = await get(`/api/reports/income-statement?from=2026-01-01&to=${DEMO_TO}`);
    assert.ok(is.totals.netProfit > 0, JSON.stringify(is.totals));
  });

  test('the September bank statement is reconciled; the advisor raises no errors', async () => {
    const statements = await get('/api/bank/statements');
    assert.equal(statements[0].status, 'reconciled');
    const advisor = await get(`/api/advisor?asOf=${DEMO_TO}`);
    assert.deepEqual(advisor.findings.filter((f: any) => f.severity === 'error').map((f: any) => f.id), []);
  });
});
