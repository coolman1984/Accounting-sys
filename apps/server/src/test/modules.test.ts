import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

describe('finance modules, roles & page-level permissions', () => {
  let c: TestClient;
  let customer: number;
  let supplier: number;
  let item: number;
  let vat: number;
  before(async () => {
    c = await setupCompany();
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Nile Foods' })).id;
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Delta Paper' })).id;
    item = (await c.post('/api/items', { sku: 'SRV', nameEn: 'Consulting', nameAr: 'استشارات', kind: 'service', salePrice: 10000 })).id;
    vat = (await c.get('/api/taxes'))[0].id;
  });
  after(() => c.close());

  const as = async (username: string, roleIds: number[]) => {
    await c.post('/api/users', { username, displayName: username, password: 'password123', roleIds });
    return c.login(username, 'password123');
  };

  test('the permission catalogue lists every module, its templates and SoD pairs', async () => {
    const cat = await c.get('/api/permissions');
    const ids = cat.modules.map((m: any) => m.id);
    for (const m of ['system', 'ledger', 'tax', 'ar', 'ap', 'payments', 'co', 'inventory', 'purchasing', 'pricing']) assert.ok(ids.includes(m), m);
    const clerk = cat.templates.find((t: any) => t.id === 'sales_clerk');
    assert.ok(clerk.permissions.includes('ar.invoices.write'));
    assert.ok(!clerk.permissions.includes('ar.invoices.post'));
    assert.ok(cat.sod.some(([a, b]: string[]) => a === 'ap.suppliers.write' && b === 'treasury.payments.post'));
  });

  test('a custom role opens exactly its pages', async () => {
    const cat = await c.get('/api/permissions');
    const perms = cat.templates.find((t: any) => t.id === 'sales_clerk').permissions;
    const role = (await c.post('/api/roles', { name: 'Sales clerk', permissions: perms })).id;
    const cookie = await as('mariam', [role]);
    const get = (url: string) => c.raw('GET', url, undefined, cookie);
    assert.equal((await get('/api/parties?kind=customer')).status, 200);
    assert.equal((await get('/api/parties?kind=supplier')).status, 403, 'suppliers belong to AP');
    assert.equal((await get('/api/documents?kind=sales_invoice')).status, 200);
    assert.equal((await get('/api/documents?kind=purchase_bill')).status, 403);
    assert.equal((await get('/api/journal')).status, 403);
    assert.equal((await get('/api/payments?direction=in')).status, 403);
    // Reference lists that an invoice needs are open to any signed-in user.
    assert.equal((await get('/api/taxes')).status, 200);
    assert.equal((await get('/api/cost-centers')).status, 200);
    assert.equal((await c.raw('POST', '/api/taxes', { code: 'X', nameEn: 'x', nameAr: 'x', rateBp: 0, scope: 'both' }, cookie)).status, 403);
    // May draft an invoice but not post it.
    const draft = await c.raw('POST', '/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-03-01', lines: [{ itemId: item, quantity: 1000, unitPrice: 10000 }] }, cookie);
    assert.equal(draft.status, 200);
    const post = await c.raw('POST', `/api/documents/${draft.body.id}/post`, {}, cookie);
    assert.equal(post.status, 403);
    assert.equal(post.body.error.details.permission, 'ar.invoices.post');
    // Granting the right applies at once — no new login.
    await c.put(`/api/roles/${role}`, { name: 'Sales clerk', permissions: [...perms, 'ar.invoices.post'] });
    assert.equal((await c.raw('POST', `/api/documents/${draft.body.id}/post`, {}, cookie)).status, 200);
  });

  test('built-in roles are fixed and one administrator always remains', async () => {
    const roles = await c.get('/api/roles');
    const admin = roles.find((r: any) => r.key === 'admin');
    assert.equal((await c.raw('PUT', `/api/roles/${admin.id}`, { name: 'x', permissions: [] })).body.error.code, 'role.builtin');
    const me = (await c.get('/api/users')).find((u: any) => u.username === 'admin');
    const res = await c.raw('PUT', `/api/users/${me.id}`, { roleIds: [roles.find((r: any) => r.key === 'viewer').id] });
    assert.equal(res.body.error.code, 'user.last_admin');
  });

  test('treasury: receipts and payments are separate rights', async () => {
    const role = (await c.post('/api/roles', { name: 'Receipts only', permissions: ['treasury.receipts.read', 'treasury.receipts.write', 'treasury.receipts.post', 'ar.customers.read'] })).id;
    const cookie = await as('sami', [role]);
    const cash = await acc(c, '1110');
    const income = await acc(c, '4200');
    const ok = await c.raw('POST', '/api/payments', { direction: 'in', date: '2026-03-02', accountId: cash, counterAccountId: income, amount: 5000, post: true }, cookie);
    assert.equal(ok.status, 200);
    const out = await c.raw('POST', '/api/payments', { direction: 'out', date: '2026-03-02', accountId: cash, counterAccountId: income, amount: 5000 }, cookie);
    assert.equal(out.status, 403);
    const list = await c.raw('GET', '/api/payments', undefined, cookie);
    assert.ok(list.body.rows.every((p: any) => p.direction === 'in'), 'only the pages the role opens');
  });

  test('CO: cost centers ride on ledger lines and give a profit & loss per center', async () => {
    const sales = (await c.post('/api/cost-centers', { code: 'SALES', nameEn: 'Sales team', nameAr: 'فريق المبيعات' })).id;
    const admin = (await c.post('/api/cost-centers', { code: 'ADMIN', nameEn: 'Administration', nameAr: 'الإدارة' })).id;
    await c.post('/api/documents', {
      kind: 'sales_invoice', partyId: customer, date: '2026-04-01', post: true,
      lines: [{ itemId: item, quantity: 2000, unitPrice: 10000, taxId: vat, costCenterId: sales }],
    });
    await c.post('/api/documents', {
      kind: 'purchase_bill', partyId: supplier, date: '2026-04-02', post: true,
      lines: [{ description: 'Office paper', quantity: 1000, unitPrice: 3000, accountId: await acc(c, '5220'), costCenterId: admin }],
    });
    const rent = await acc(c, '5220');
    const cash = await acc(c, '1110');
    const travel = (await c.post('/api/journal', { date: '2026-04-03', memo: 'Sales travel', post: true, lines: [{ accountId: rent, debit: 1500, costCenterId: sales }, { accountId: cash, credit: 1500 }] })).id;
    assert.equal((await c.get(`/api/journal/${travel}`)).lines[0].cost_center_id, sales);
    const rep = await c.get('/api/reports/cost-centers?from=2026-04-01&to=2026-04-30');
    const profit = (id: number | null) => rep.profit.find((p: any) => p.cost_center_id === id).profit;
    assert.equal(profit(sales), 20000 - 1500);
    assert.equal(profit(admin), -3000);
    // Tax lines never carry a cost center; the ledger still balances.
    assert.equal((await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).balanced, true);
    // With CO switched off, cost centers cannot be used.
    const all = (await c.get('/api/system/apps')).filter((a: any) => a.enabled && !a.core).map((a: any) => a.id);
    await c.put('/api/system/apps', { enabled: all.filter((x: string) => x !== 'co') });
    const res = await c.raw('POST', '/api/journal', { date: '2026-04-04', post: true, lines: [{ accountId: rent, debit: 100, costCenterId: sales }, { accountId: cash, credit: 100 }] });
    assert.equal(res.body.error.code, 'co.unavailable');
    // A reversal mirrors the original, cost center included — even with CO off.
    const rev = (await c.post(`/api/journal/${travel}/reverse`, {})).id;
    assert.equal((await c.get(`/api/journal/${rev}`)).lines[0].cost_center_id, sales);
    await c.put('/api/system/apps', { enabled: all });
    const after = await c.get('/api/reports/cost-centers?from=2026-04-01&to=2026-04-30');
    assert.equal(after.profit.find((p: any) => p.cost_center_id === sales).profit, 20000);
  });

  test('Tax: switched off, lines carry no tax and tax codes are hidden', async () => {
    const all = (await c.get('/api/system/apps')).filter((a: any) => a.enabled && !a.core).map((a: any) => a.id);
    await c.put('/api/system/apps', { enabled: all.filter((x: string) => x !== 'tax') });
    assert.equal((await c.raw('GET', '/api/taxes')).status, 403);
    const id = (await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-05-01', lines: [{ itemId: item, quantity: 1000, unitPrice: 10000, taxId: vat }] })).id;
    const d = await c.get(`/api/documents/${id}`);
    assert.equal(d.tax_total, 0);
    assert.equal(d.lines[0].tax_id, null);
    await c.put('/api/system/apps', { enabled: all });
  });

  test('every module reports healthy', async () => {
    const h = await c.get('/api/system/health');
    const bad = h.flatMap((m: any) => [...(m.error ? [m.module] : []), ...m.checks.filter((x: any) => !x.ok && x.severity !== 'warning').map((x: any) => `${m.module}.${x.id}`)]);
    assert.deepEqual(bad, []);
  });
});
