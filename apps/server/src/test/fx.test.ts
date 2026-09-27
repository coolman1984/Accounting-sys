import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

/**
 * Worked example (base EGP):
 *   03-01 invoice USD 1,000 at 48      → receivable 48,000
 *   03-15 receipt USD 600 at 49        → cash 29,400; receivable −28,800; realised gain 600
 *   03-31 revaluation, rate 50         → open USD 400 carried at 19,200 → 20,000: unrealised gain 800 (reversed 04-01)
 *   04-10 receipt USD 400 at 50        → cash 20,000; receivable −19,200 (exact remainder); realised gain 800
 */
describe('multi-currency', () => {
  let c: TestClient;
  let customer: number, supplier: number, bank: number, usdBank: number, cash: number, vat: number, rent: number;
  const R = (x: number) => Math.round(x * 1_000_000);
  const ledgerBal = async (accountId: number, to = '2026-12-31') =>
    (await c.get(`/api/reports/trial-balance?from=2026-01-01&to=${to}`)).rows.find((r: any) => r.id === accountId) ?? { closing_debit: 0, closing_credit: 0 };
  const gainAcc = async () => (await c.get('/api/accounts')).find((a: any) => a.code === '4950').id;
  const lossAcc = async () => (await c.get('/api/accounts')).find((a: any) => a.code === '5850').id;

  before(async () => {
    c = await setupCompany();
    [bank, cash, rent] = await Promise.all(['1120', '1110', '5220'].map((x) => acc(c, x)));
    vat = (await c.get('/api/taxes')).find((t: any) => t.code === 'VAT').id;
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Gulf Buyer' })).id;
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Shenzhen Parts' })).id;
    for (const [date, rate] of [['2026-03-01', 48], ['2026-03-15', 49], ['2026-03-31', 50]] as const) {
      await c.post('/api/fx/rates', { currency: 'USD', date, rate: R(rate) });
    }
    const group = (await c.get('/api/accounts')).find((a: any) => a.code === '11').id;
    usdBank = (await c.post('/api/accounts', { code: '1125', nameEn: 'Bank USD', nameAr: 'بنك دولار', type: 'asset', subtype: 'bank', parentId: group, currency: 'USD' })).id;
  });
  after(() => c.close());

  let invoice: number;
  test('an invoice in USD is booked in EGP at the day’s rate', async () => {
    invoice = (await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-03-01', currency: 'USD', post: true, lines: [{ description: 'Export order', quantity: 1000, unitPrice: 1000_00 }] })).id;
    const d = await c.get(`/api/documents/${invoice}`);
    assert.equal(d.currency, 'USD');
    assert.equal(d.exchange_rate, R(48));
    assert.equal(d.total, 1000_00);
    assert.equal(d.base_total, 48_000_00);
    const je = await c.get(`/api/journal/${d.journal_entry_id}`);
    const ar = je.lines.find((l: any) => l.party_id === customer);
    assert.equal(ar.debit, 48_000_00);
    assert.equal(ar.currency, 'USD');
    assert.equal(ar.amount_fx, 1000_00);
  });

  test('a partial receipt at a better rate books a realised gain', async () => {
    const { id } = await c.post('/api/payments', {
      direction: 'in', date: '2026-03-15', partyId: customer, partyRole: 'customer', accountId: bank, amount: 600_00, currency: 'USD', post: true,
      allocations: [{ documentId: invoice, amount: 600_00 }],
    });
    const p = await c.get(`/api/payments/${id}`);
    const je = await c.get(`/api/journal/${p.journal_entry_id}`);
    const line = (a: number) => je.lines.find((l: any) => l.account_id === a);
    assert.equal(line(bank).debit, 29_400_00);
    assert.equal(je.lines.find((l: any) => l.party_id === customer).credit, 28_800_00);
    const g = await gainAcc();
    assert.equal(line(g).credit, 600_00);
    const d = await c.get(`/api/documents/${invoice}`);
    assert.equal(d.amount_settled, 600_00);
    assert.equal(d.base_settled, 28_800_00);
  });

  test('month-end revaluation: unrealised gain on what is still open, reversed next day', async () => {
    const preview = await c.get('/api/fx/revaluations/preview?date=2026-03-31');
    const usd = preview.open.find((g: any) => g.currency === 'USD' && g.side === 'receivable');
    assert.equal(usd.fx, 400_00);
    assert.equal(usd.carrying, 19_200_00);
    assert.equal(usd.revalued, 20_000_00);
    assert.equal(usd.difference, 800_00);
    const rv = await c.post('/api/fx/revaluations', { date: '2026-03-31' });
    assert.equal(rv.net, 800_00);
    const reval = (await c.get('/api/accounts')).find((a: any) => a.code === '1195').id;
    assert.equal((await ledgerBal(reval, '2026-03-31')).closing_debit, 800_00, 'on the 31st the receivable shows at the closing rate');
    assert.equal((await ledgerBal(reval, '2026-04-01')).closing_debit, 0, 'and the reversal clears it on the 1st');
    const twice = await c.raw('POST', '/api/fx/revaluations', { date: '2026-03-31' });
    assert.equal(twice.body.error.code, 'fx.already_revalued');
  });

  test('the last receipt clears exactly what is left in base currency', async () => {
    await c.post('/api/payments', {
      direction: 'in', date: '2026-04-10', partyId: customer, partyRole: 'customer', accountId: bank, amount: 400_00, currency: 'USD', post: true,
      allocations: [{ documentId: invoice, amount: 400_00 }],
    });
    const d = await c.get(`/api/documents/${invoice}`);
    assert.equal(d.amount_settled, d.total);
    assert.equal(d.base_settled, d.base_total);
    // The customer's receivable is exactly zero, in both currencies.
    const aging = await c.get('/api/reports/aging?type=receivable&asOf=2026-12-31');
    assert.equal(aging.rows.find((r: any) => r.party_id === customer)?.total ?? 0, 0);
    const gain = (await ledgerBal(await gainAcc())).closing_credit;
    assert.equal(gain, 600_00 + 800_00, 'realised gains only — the unrealised one was reversed');
  });

  test('purchase in USD with VAT: tax and stock-free expense in base; tax report in base', async () => {
    const id = (await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-03-15', currency: 'USD', post: true, lines: [{ description: 'Parts', quantity: 1000, unitPrice: 100_00, accountId: rent, taxId: vat }] })).id;
    const d = await c.get(`/api/documents/${id}`);
    assert.equal(d.base_tax_total, 686_00); // 14 USD × 49
    const tax = await c.get('/api/reports/tax-summary?from=2026-03-01&to=2026-03-31');
    assert.equal(tax.input, 686_00);
  });

  test('stock bought in USD enters inventory at its EGP value', async () => {
    const item = (await c.post('/api/items', { sku: 'CHIP', nameEn: 'Chip', nameAr: 'شريحة', kind: 'product' })).id;
    await c.post('/api/documents', { kind: 'purchase_bill', partyId: supplier, date: '2026-03-15', currency: 'USD', post: true, lines: [{ itemId: item, quantity: 10_000, unitPrice: 10_00 }] });
    const v = await c.get('/api/inventory/reports/valuation?asOf=2026-03-31');
    const row = v.rows.find((r: any) => r.item_id === item || r.id === item);
    assert.equal(row.value, 4_900_00); // 10 × USD 10 × 49
    assert.equal(v.difference, 0, 'stock value equals the inventory account');
  });

  test('a credit note must be in the invoice’s currency and uses its rate', async () => {
    const bad = await c.raw('POST', '/api/documents', { kind: 'sales_credit', partyId: customer, date: '2026-04-11', againstDocumentId: invoice, lines: [{ description: 'x', quantity: 1000, unitPrice: 100 }] });
    assert.equal(bad.body.error.code, 'fx.currency_mismatch');
    const inv2 = (await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-03-15', currency: 'USD', post: true, lines: [{ description: 'B', quantity: 1000, unitPrice: 333_33 }] })).id;
    const cn = (await c.post('/api/documents', { kind: 'sales_credit', partyId: customer, date: '2026-03-31', currency: 'USD', againstDocumentId: inv2, post: true, lines: [{ description: 'Return', quantity: 1000, unitPrice: 333_33 }] })).id;
    const d = await c.get(`/api/documents/${cn}`);
    assert.equal(d.exchange_rate, R(49), 'the return takes the invoice rate, not the rate of its own date');
    assert.equal((await c.get(`/api/documents/${inv2}`)).base_settled, (await c.get(`/api/documents/${inv2}`)).base_total);
  });

  test('a USD bank account only moves USD, and needs the USD amount on journal lines', async () => {
    const wrong = await c.raw('POST', '/api/payments', { direction: 'in', date: '2026-03-15', accountId: usdBank, counterAccountId: await acc(c, '4900'), amount: 100 });
    assert.equal(wrong.body.error.code, 'fx.account_currency');
    await c.post('/api/payments', { direction: 'in', date: '2026-03-15', accountId: usdBank, counterAccountId: await acc(c, '4900'), amount: 1_000_00, currency: 'USD', post: true });
    const acct = (await c.get('/api/bank/accounts')).find((a: any) => a.id === usdBank);
    assert.equal(acct.balance_fx, 1_000_00);
    assert.equal(acct.balance, 49_000_00);
    const manual = await c.raw('POST', '/api/journal', { date: '2026-03-16', post: true, lines: [{ accountId: usdBank, debit: 100 }, { accountId: cash, credit: 100 }] });
    assert.equal(manual.body.error.code, 'fx.amount_required');
  });

  test('selling dollars: transfer USD → EGP books the exchange difference', async () => {
    const { id } = await c.post('/api/bank/transfers', { date: '2026-03-31', fromAccountId: usdBank, toAccountId: bank, amount: 100_00, toAmount: 5_050_00, post: true });
    const t = await c.get(`/api/bank/transfers/${id}`);
    const je = await c.get(`/api/journal/${t.entry_id}`);
    assert.equal(je.lines.find((l: any) => l.account_id === usdBank).credit, 5_000_00);
    assert.equal(je.lines.find((l: any) => l.account_id === bank).debit, 5_050_00);
    const g = await gainAcc();
    assert.equal(je.lines.find((l: any) => l.account_id === g)?.credit, 50_00);
    const same = await c.raw('POST', '/api/bank/transfers', { date: '2026-03-31', fromAccountId: usdBank, toAccountId: bank, amount: 100 });
    assert.equal(same.body.error.code, 'bank.to_amount_required');
  });

  test('guards: missing rate, base currency rate, switching off a currency in use', async () => {
    const noRate = await c.raw('POST', '/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-03-01', currency: 'GBP', lines: [{ description: 'x', quantity: 1000, unitPrice: 100 }] });
    assert.equal(noRate.body.error.code, 'fx.no_rate');
    assert.equal((await c.raw('POST', '/api/fx/rates', { currency: 'EGP', date: '2026-03-01', rate: R(1) })).body.error.code, 'fx.base_currency');
    const open = (await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-03-31', currency: 'USD', post: true, lines: [{ description: 'Open', quantity: 1000, unitPrice: 10_00 }] })).id;
    const off = await c.raw('PUT', '/api/currencies/USD', { nameEn: 'US Dollar', nameAr: 'دولار', isActive: false });
    assert.equal(off.body.error.code, 'fx.in_use');
    assert.ok(open);
  });

  test('the books still balance and every health check passes', async () => {
    assert.equal((await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31')).balanced, true);
    const health = await c.get('/api/system/health');
    const bad = health.flatMap((m: any) => m.checks.filter((x: any) => !x.ok && x.severity !== 'warning').map((x: any) => `${m.module}.${x.id}`));
    assert.deepEqual(bad, []);
    void lossAcc;
  });
});
