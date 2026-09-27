import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acc, setupCompany, type TestClient } from './helpers.js';

/** Regression tests for the bugs found in the full code review (one test per finding). */
describe('code review regressions', () => {
  let c: TestClient;
  const K = 100;
  let bank: number, rent: number, capital: number, sales: number, customer: number;
  const je = (date: string, lines: [number, number, number][]) =>
    c.post('/api/journal', { date, post: true, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit: debit * K, credit: credit * K })) });
  const setActive = async (id: number, isActive: boolean) => {
    const a = (await c.get('/api/accounts')).find((x: any) => x.id === id);
    await c.put(`/api/accounts/${id}`, { code: a.code, nameEn: a.name_en, nameAr: a.name_ar, type: a.type, subtype: a.subtype, parentId: a.parent_id, isGroup: !!a.is_group, isActive, description: a.description });
  };

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    [bank, rent, capital] = await Promise.all(['1120', '5220', '3100'].map((x) => acc(c, x)));
    const parent = (await c.get('/api/accounts')).find((a: any) => a.code === '4100').parent_id;
    sales = (await c.post('/api/accounts', { code: '4300', nameEn: 'Consulting', nameAr: 'استشارات', type: 'income', subtype: 'operating_income', parentId: parent, isGroup: false, isActive: true, description: null })).id;
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Nile' })).id;
    await je('2026-01-01', [[bank, 10_000, 0], [capital, 0, 10_000]]);
  });
  after(() => c.close());

  test('an entry on an account deactivated since can still be reversed, and the year still closes', async () => {
    const e = await je('2026-02-01', [[rent, 500, 0], [bank, 0, 500]]);
    await setActive(rent, false);
    const bad = await c.raw('POST', '/api/journal', { date: '2026-02-02', post: true, lines: [{ accountId: rent, debit: 100, credit: 0 }, { accountId: bank, debit: 0, credit: 100 }] });
    assert.equal(bad.body.error.code, 'journal.inactive_account', 'new postings are still refused');
    const inv = await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-02-03', post: true, lines: [{ description: 'Work', quantity: 1000, unitPrice: 800 * K, accountId: sales }] });
    await setActive(sales, false);
    await c.post(`/api/documents/${inv.id}/void`, {});
    await c.post(`/api/journal/${e.id}/reverse`, {});
    await setActive(sales, true);
    await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-03-05', post: true, lines: [{ description: 'Work', quantity: 1000, unitPrice: 300 * K, accountId: sales }] });
    await setActive(sales, false);
    const fy = (await c.get('/api/fiscal-years'))[0];
    const closed = await c.raw('POST', `/api/fiscal-years/${fy.id}/close`);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    await c.post(`/api/fiscal-years/${fy.id}/reopen`);
    await setActive(sales, true);
    await setActive(rent, true);
  });

  test('editing one field of a user never reactivates it or resets its language', async () => {
    const id = (await c.post('/api/users', { username: 'mona', displayName: 'Mona', password: 'password123', role: 'viewer', locale: 'ar', isActive: false })).id;
    await c.put(`/api/users/${id}`, { displayName: 'Mona Adel' });
    const u = (await c.get('/api/users')).find((x: any) => x.id === id);
    assert.equal(u.display_name, 'Mona Adel');
    assert.equal(!!u.is_active, false, 'still inactive');
    assert.equal(u.locale, 'ar', 'language kept');
    const dup = await c.raw('PUT', `/api/users/${id}`, { username: 'admin' });
    assert.equal(dup.status, 409);
  });

  test('duplicate codes are a clear 409, never a server error', async () => {
    const tries: [string, unknown][] = [
      ['/api/parties', { kind: 'customer', name: 'Dup', code: 'C-DUP' }],
      ['/api/items', { sku: 'DUP', nameEn: 'Dup', nameAr: 'Dup', kind: 'service', salePrice: 1 }],
      ['/api/accounts', { code: '1120', nameEn: 'Dup', nameAr: 'Dup', type: 'asset', subtype: 'bank', parentId: null, isGroup: false, isActive: true, description: null }],
      ['/api/inventory/warehouses', { code: 'MAIN', nameEn: 'Dup', nameAr: 'Dup' }],
    ];
    for (const [url, body] of tries) {
      await c.raw('POST', url, body);
      const r = await c.raw('POST', url, body);
      assert.ok(r.status >= 400 && r.status < 500, `${url} → ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  test('a credit note whose invoice was voided in the meantime is refused clearly', async () => {
    const inv = await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-04-01', post: true, lines: [{ description: 'Work', quantity: 1000, unitPrice: 100 * K }] });
    const cn = await c.post('/api/documents', { kind: 'sales_credit', partyId: customer, date: '2026-04-02', againstDocumentId: inv.id, lines: [{ description: 'Back', quantity: 1000, unitPrice: 50 * K }] });
    await c.post(`/api/documents/${inv.id}/void`, {});
    const r = await c.raw('POST', `/api/documents/${cn.id}/post`);
    assert.equal(r.body.error.code, 'document.against_invalid');
  });

  test('dashboard: cash per account matches the cash total when entries are dated in the future', async () => {
    await je('2026-12-20', [[rent, 50, 0], [bank, 0, 50]]);
    const d = await c.get('/api/reports/dashboard');
    const sumAccounts = d.cashAccounts.reduce((s: number, a: any) => s + a.balance, 0);
    assert.equal(sumAccounts, d.cash);
  });

  test('no page route starts with /assets (the built bundles are served from there)', () => {
    const root = join(import.meta.dirname, '../../../web/src');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.tsx') ? [join(d, f)] : []));
    const bad = walk(root).filter((f) => /path: '\/assets(\/|')/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(bad, []);
  });
});
