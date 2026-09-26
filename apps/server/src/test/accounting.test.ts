import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

describe('accounting core — end to end', () => {
  let c: TestClient;
  let ids: Record<string, number>;
  let customer: number;
  let supplier: number;
  let vat: number;

  before(async () => {
    c = await setupCompany();
    ids = {};
    for (const code of ['1110', '1120', '1130', '1210', '2110', '2120', '1150', '3100', '3200', '4100', '4200', '5150', '5220']) {
      ids[code] = await acc(c, code);
    }
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Nile Trading' })).id;
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Delta Supplies' })).id;
    vat = (await c.get<{ id: number; code: string }[]>('/api/taxes')).find((t) => t.code === 'VAT')!.id;
  });
  after(() => c.close());

  test('setup seeded the chart, a fiscal year, and VAT', async () => {
    const fy = await c.get('/api/fiscal-years');
    assert.equal(fy.length, 1);
    assert.equal(fy[0].start_date, '2026-01-01');
    assert.equal(fy[0].end_date, '2026-12-31');
    const meta = await c.get('/api/accounts/meta');
    assert.equal(meta.defaults.receivable, ids['1130']);
    assert.equal(meta.defaults.vatOutput, ids['2120']);
  });

  test('unbalanced journal entries are rejected', async () => {
    const res = await c.raw('POST', '/api/journal', {
      date: '2026-01-02',
      post: true,
      lines: [
        { accountId: ids['1120'], debit: 100000 },
        { accountId: ids['3100'], credit: 90000 },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'journal.unbalanced');
  });

  test('a line cannot have both debit and credit, nor post to a group', async () => {
    const both = await c.raw('POST', '/api/journal', {
      date: '2026-01-02',
      lines: [
        { accountId: ids['1120'], debit: 100, credit: 100 },
        { accountId: ids['3100'], credit: 0 },
      ],
    });
    assert.equal(both.body.error.code, 'journal.one_side');
    const group = (await c.get('/api/accounts')).find((a: any) => a.code === '11').id;
    const g = await c.raw('POST', '/api/journal', {
      date: '2026-01-02',
      lines: [
        { accountId: group, debit: 100 },
        { accountId: ids['3100'], credit: 100 },
      ],
    });
    assert.equal(g.body.error.code, 'journal.group_account');
  });

  test('receivable lines need a party', async () => {
    const res = await c.raw('POST', '/api/journal', {
      date: '2026-01-02',
      post: true,
      lines: [
        { accountId: ids['1130'], debit: 500 },
        { accountId: ids['4100'], credit: 500 },
      ],
    });
    assert.equal(res.body.error.code, 'journal.party_required');
  });

  let capitalEntry: number;
  test('owner capital: balanced entry posts and gets a number', async () => {
    const { id } = await c.post('/api/journal', {
      date: '2026-01-01',
      memo: 'Initial capital',
      post: true,
      opening: true,
      lines: [
        { accountId: ids['1120'], debit: 10_000_000 },
        { accountId: ids['3100'], credit: 10_000_000 },
      ],
    });
    capitalEntry = id;
    const e = await c.get(`/api/journal/${id}`);
    assert.equal(e.status, 'posted');
    assert.equal(e.number, 'JE-000001');
    assert.equal(e.total, 10_000_000);
  });

  test('the database itself refuses to alter a posted entry', () => {
    const db = c.app.kernel.db;
    assert.throws(() => db.run('UPDATE journal_lines SET debit = 1 WHERE entry_id = ?', [capitalEntry]), /immutable/);
    assert.throws(() => db.run('DELETE FROM journal_entries WHERE id = ?', [capitalEntry]), /cannot be deleted/);
    assert.throws(() => db.run('UPDATE journal_entries SET date = ? WHERE id = ?', ['2026-02-02', capitalEntry]), /immutable/);
  });

  test('draft → edit → post, then reverse', async () => {
    const { id } = await c.post('/api/journal', {
      date: '2026-01-05',
      lines: [
        { accountId: ids['5220'], debit: 300_00 },
        { accountId: ids['1110'], credit: 300_00 },
      ],
    });
    let e = await c.get(`/api/journal/${id}`);
    assert.equal(e.status, 'draft');
    assert.equal(e.number, null);
    await c.put(`/api/journal/${id}`, {
      date: '2026-01-05',
      memo: 'Rent',
      lines: [
        { accountId: ids['5220'], debit: 400_00 },
        { accountId: ids['1120'], credit: 400_00 },
      ],
    });
    await c.post(`/api/journal/${id}/post`);
    e = await c.get(`/api/journal/${id}`);
    assert.equal(e.status, 'posted');
    assert.equal(e.total, 400_00);
    const rev = await c.post(`/api/journal/${id}/reverse`, {});
    const r = await c.get(`/api/journal/${rev.id}`);
    assert.equal(r.reversal_of_id, id);
    assert.equal(r.lines[0].credit, 400_00);
    const again = await c.raw('POST', `/api/journal/${id}/reverse`, {});
    assert.equal(again.body.error.code, 'journal.already_reversed');
  });

  let invoice: number;
  test('sales invoice with VAT computes totals and posts a balanced entry', async () => {
    const { id } = await c.post('/api/documents', {
      kind: 'sales_invoice',
      partyId: customer,
      date: '2026-02-01',
      dueDate: '2026-03-03',
      post: true,
      lines: [
        { description: 'Consulting', quantity: 2500, unitPrice: 1000_00, taxId: vat }, // 2.5 x 1000 = 2500
        { description: 'Setup', quantity: 1000, unitPrice: 500_00, discountBp: 1000, taxId: vat }, // 500 - 10% = 450
      ],
    });
    invoice = id;
    const d = await c.get(`/api/documents/${id}`);
    assert.equal(d.number, 'INV-00001');
    assert.equal(d.subtotal, 2950_00);
    assert.equal(d.discount_total, 50_00);
    assert.equal(d.tax_total, 413_00); // 14% of 2950
    assert.equal(d.total, 3363_00);
    const je = await c.get(`/api/journal/${d.journal_entry_id}`);
    const line = (a: number) => je.lines.find((l: any) => l.account_id === a);
    assert.equal(line(ids['1130']).debit, 3363_00);
    assert.equal(line(ids['1130']).party_id, customer);
    assert.equal(line(ids['4100']).credit, 2950_00);
    assert.equal(line(ids['2120']).credit, 413_00);
  });

  test('posted documents cannot be edited or deleted', async () => {
    const put = await c.raw('PUT', `/api/documents/${invoice}`, {
      kind: 'sales_invoice',
      partyId: customer,
      date: '2026-02-01',
      lines: [{ description: 'x', quantity: 1000, unitPrice: 1 }],
    });
    assert.equal(put.body.error.code, 'document.not_draft');
    const del = await c.raw('DELETE', `/api/documents/${invoice}`);
    assert.equal(del.body.error.code, 'document.not_draft');
  });

  let receipt: number;
  test('partial receipt settles the invoice; voiding it restores the balance', async () => {
    const { id } = await c.post('/api/payments', {
      direction: 'in',
      date: '2026-02-10',
      partyId: customer,
      partyRole: 'customer',
      accountId: ids['1120'],
      amount: 1000_00,
      method: 'bank_transfer',
      allocations: [{ documentId: invoice, amount: 1000_00 }],
      post: true,
    });
    receipt = id;
    let d = await c.get(`/api/documents/${invoice}`);
    assert.equal(d.amount_settled, 1000_00);
    assert.equal(d.settlements[0].source_number, 'RCT-00001');

    const over = await c.raw('POST', '/api/payments', {
      direction: 'in',
      date: '2026-02-11',
      partyId: customer,
      partyRole: 'customer',
      accountId: ids['1120'],
      amount: 5000_00,
      allocations: [{ documentId: invoice, amount: 5000_00 }],
    });
    assert.equal(over.body.error.code, 'settlement.exceeds');

    const voidInv = await c.raw('POST', `/api/documents/${invoice}/void`, {});
    assert.equal(voidInv.body.error.code, 'document.has_settlements');

    await c.post(`/api/payments/${receipt}/void`, {});
    d = await c.get(`/api/documents/${invoice}`);
    assert.equal(d.amount_settled, 0);

    // Pay it again for real.
    await c.post('/api/payments', {
      direction: 'in',
      date: '2026-02-12',
      partyId: customer,
      partyRole: 'customer',
      accountId: ids['1120'],
      amount: 2000_00,
      allocations: [{ documentId: invoice, amount: 2000_00 }],
      post: true,
    });
  });

  test('credit note against the invoice settles the remainder', async () => {
    const { id } = await c.post('/api/documents', {
      kind: 'sales_credit',
      partyId: customer,
      date: '2026-02-15',
      againstDocumentId: invoice,
      post: true,
      lines: [{ description: 'Discount granted', quantity: 1000, unitPrice: 1000_00, taxId: vat }], // 1140
    });
    const cn = await c.get(`/api/documents/${id}`);
    assert.equal(cn.number, 'CN-00001');
    assert.equal(cn.total, 1140_00);
    const inv = await c.get(`/api/documents/${invoice}`);
    assert.equal(inv.amount_settled, 3140_00); // 2000 paid + 1140 credited
    const je = await c.get(`/api/journal/${cn.journal_entry_id}`);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['1130']).credit, 1140_00);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['4100']).debit, 1000_00);
  });

  test('purchase bill and supplier payment', async () => {
    const { id } = await c.post('/api/documents', {
      kind: 'purchase_bill',
      partyId: supplier,
      date: '2026-03-01',
      reference: 'SUP-7781',
      post: true,
      lines: [
        { description: 'Office chairs', quantity: 4000, unitPrice: 750_00, accountId: ids['1210'], taxId: vat },
        { description: 'Stock', quantity: 10000, unitPrice: 100_00, taxId: vat },
      ],
    });
    const bill = await c.get(`/api/documents/${id}`);
    assert.equal(bill.total, 4560_00); // (3000 + 1000) * 1.14
    const je = await c.get(`/api/journal/${bill.journal_entry_id}`);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['2110']).credit, 4560_00);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['1210']).debit, 3000_00);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['5150']).debit, 1000_00);
    assert.equal(je.lines.find((l: any) => l.account_id === ids['1150']).debit, 560_00);

    await c.post('/api/payments', {
      direction: 'out',
      date: '2026-03-05',
      partyId: supplier,
      partyRole: 'supplier',
      accountId: ids['1120'],
      amount: 4560_00,
      allocations: [{ documentId: id, amount: 4560_00 }],
      post: true,
    });
    const paid = await c.get(`/api/documents/${id}`);
    assert.equal(paid.amount_settled, paid.total);
  });

  test('direct expense payment without a party', async () => {
    await c.post('/api/payments', {
      direction: 'out',
      date: '2026-03-10',
      accountId: ids['1110'],
      counterAccountId: ids['5220'],
      amount: 150_00,
      memo: 'Petty cash rent top-up',
      post: true,
    });
  });

  test('tax-inclusive pricing splits net and tax', async () => {
    const { id } = await c.post('/api/documents', {
      kind: 'sales_invoice',
      partyId: customer,
      date: '2026-03-15',
      taxInclusive: true,
      post: true,
      lines: [{ description: 'Retail', quantity: 1000, unitPrice: 114_00, taxId: vat }],
    });
    const d = await c.get(`/api/documents/${id}`);
    assert.equal(d.total, 114_00);
    assert.equal(d.subtotal, 100_00);
    assert.equal(d.tax_total, 14_00);
  });

  test('trial balance is balanced', async () => {
    const tb = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(tb.balanced, true);
    assert.equal(tb.totals.closing_debit, tb.totals.closing_credit);
  });

  test('balance sheet balances and cash flow reconciles', async () => {
    const bs = await c.get('/api/reports/balance-sheet?asOf=2026-12-31');
    assert.equal(bs.totals.balanced, true, JSON.stringify(bs.totals));
    const cf = await c.get('/api/reports/cash-flow?from=2026-01-01&to=2026-12-31');
    assert.equal(cf.reconciled, true);
    const cashNow = (await c.get('/api/payments/accounts')).reduce((s: number, a: any) => s + a.balance, 0);
    assert.equal(cf.closingCash, cashNow);
  });

  test('income statement: net profit equals the balance-sheet current earnings', async () => {
    const is = await c.get('/api/reports/income-statement?from=2026-01-01&to=2026-12-31');
    const bs = await c.get('/api/reports/balance-sheet?asOf=2026-12-31');
    assert.equal(is.totals.netProfit, bs.currentEarnings);
    // Revenue: 2950 invoice - 1000 credit + 100 retail = 2050
    assert.equal(is.totals.revenue, 2050_00);
  });

  test('receivables aging reconciles with the ledger', async () => {
    const ag = await c.get('/api/reports/aging?type=receivable&asOf=2026-12-31');
    const party = await c.get(`/api/parties/${customer}`);
    const row = ag.rows.find((r: any) => r.party_id === customer);
    assert.equal(row.total, party.receivable);
    assert.equal(row.unapplied, 0);
    // Still open: 223.00 left on the first invoice (3363 - 2000 paid - 1140 credited) + the 114.00 retail invoice.
    assert.equal(row.documents, 337_00);
    const open = ag.details.filter((d: any) => d.party_id === customer).map((d: any) => d.outstanding).sort();
    assert.deepEqual(open, [114_00, 223_00]);
  });

  test('party statement shows a running balance', async () => {
    const st = await c.get(`/api/parties/${customer}/statement?from=2026-01-01&to=2026-12-31`);
    assert.equal(st.closing, 337_00);
    assert.equal(st.rows.at(-1).balance, 337_00);
  });

  test('VAT summary: output minus input', async () => {
    const t = await c.get('/api/reports/tax-summary?from=2026-01-01&to=2026-12-31');
    assert.equal(t.output, 413_00 - 140_00 + 14_00);
    assert.equal(t.input, 560_00);
    assert.equal(t.net, t.output - t.input);
  });

  test('lock date blocks posting in locked periods', async () => {
    await c.put('/api/settings/lock-date', { lockDate: '2026-01-31' });
    const res = await c.raw('POST', '/api/journal', {
      date: '2026-01-20',
      post: true,
      lines: [
        { accountId: ids['5220'], debit: 100 },
        { accountId: ids['1110'], credit: 100 },
      ],
    });
    assert.equal(res.body.error.code, 'period.locked');
    await c.put('/api/settings/lock-date', { lockDate: null });
  });

  test('year-end close moves profit to retained earnings and locks the year', async () => {
    const before = await c.get('/api/reports/income-statement?from=2026-01-01&to=2026-12-31');
    const fy = (await c.get('/api/fiscal-years'))[0];
    const { closingEntryId } = await c.post(`/api/fiscal-years/${fy.id}/close`);
    assert.ok(closingEntryId);

    const years = await c.get('/api/fiscal-years');
    assert.equal(years[0].status, 'closed');
    assert.equal(years.length, 2, 'next fiscal year was opened');
    assert.equal(years[1].start_date, '2027-01-01');

    // P&L for the closed year is unchanged (closing entries are excluded).
    const afterIs = await c.get('/api/reports/income-statement?from=2026-01-01&to=2026-12-31');
    assert.equal(afterIs.totals.netProfit, before.totals.netProfit);

    const bs = await c.get('/api/reports/balance-sheet?asOf=2026-12-31');
    assert.equal(bs.currentEarnings, 0);
    assert.equal(bs.totals.balanced, true);
    const re = bs.sections.equity.find((r: any) => r.code === '3200');
    assert.equal(re.amount, before.totals.netProfit);

    const res = await c.raw('POST', '/api/journal', {
      date: '2026-06-01',
      post: true,
      lines: [
        { accountId: ids['5220'], debit: 100 },
        { accountId: ids['1110'], credit: 100 },
      ],
    });
    assert.equal(res.body.error.code, 'period.closed');

    // Reopen and everything is back.
    await c.post(`/api/fiscal-years/${fy.id}/reopen`);
    const bs2 = await c.get('/api/reports/balance-sheet?asOf=2026-12-31');
    assert.equal(bs2.currentEarnings, before.totals.netProfit);
    assert.equal(bs2.totals.balanced, true);
  });

  test('viewer role can read but not write', async () => {
    await c.post('/api/users', { username: 'viewer', displayName: 'Viewer', role: 'viewer', password: 'password123' });
    const cookie = await c.login('viewer', 'password123');
    const read = await c.raw('GET', '/api/reports/trial-balance', undefined, cookie);
    assert.equal(read.status, 200);
    const write = await c.raw('POST', '/api/parties', { kind: 'customer', name: 'X' }, cookie);
    assert.equal(write.status, 403);
    const users = await c.raw('GET', '/api/users', undefined, cookie);
    assert.equal(users.status, 403);
  });

  test('unauthenticated requests are rejected', async () => {
    const res = await c.raw('GET', '/api/accounts', undefined, 'mizan_sid=bogus');
    assert.equal(res.status, 401);
  });

  test('audit trail recorded the story and cannot be altered', async () => {
    const log = await c.get('/api/audit?limit=500');
    assert.ok(log.rows.some((r: any) => r.action === 'void' && r.entity === 'payment'));
    assert.throws(() => c.app.kernel.db.run('DELETE FROM audit_log'), /append-only/);
  });
});
