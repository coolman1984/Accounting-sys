import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

describe('banking: transfers and bank reconciliation', () => {
  let c: TestClient;
  let cash: number, bank: number, charges: number, capital: number, rent: number, income: number, customer: number;
  const balance = async (id: number) => (await c.get('/api/bank/accounts')).find((a: any) => a.id === id).balance;

  before(async () => {
    c = await setupCompany();
    [cash, bank, charges, rent, income] = await Promise.all(['1110', '1120', '5800', '5220', '4900'].map((x) => acc(c, x)));
    capital = (await c.get('/api/accounts')).find((a: any) => a.type === 'equity' && !a.is_group).id;
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Nile Trading' })).id;
    // Opening money in the bank.
    await c.post('/api/journal', { date: '2026-01-01', memo: 'Capital', post: true, lines: [{ accountId: bank, debit: 1_000_000 }, { accountId: capital, credit: 1_000_000 }] });
  });
  after(() => c.close());

  test('a transfer moves money between accounts and books the bank charges', async () => {
    const { id } = await c.post('/api/bank/transfers', { date: '2026-01-05', fromAccountId: bank, toAccountId: cash, amount: 200_000, fee: 1_500, feeAccountId: charges, memo: 'Petty cash', post: true });
    const t = await c.get(`/api/bank/transfers/${id}`);
    assert.equal(t.status, 'posted');
    assert.match(t.number, /^TRF-/);
    assert.equal(await balance(cash), 200_000);
    assert.equal(await balance(bank), 1_000_000 - 201_500);
    const je = await c.get(`/api/journal/${t.entry_id}`);
    assert.equal(je.source_type, 'transfer');
    assert.equal(je.lines.length, 3);
  });

  test('transfer rules: two different cash/bank accounts, charges need an expense account', async () => {
    const bad = async (body: object) => (await c.raw('POST', '/api/bank/transfers', { date: '2026-01-06', fromAccountId: bank, toAccountId: cash, amount: 100, ...body })).body.error.code;
    assert.equal(await bad({ toAccountId: bank }), 'bank.same_account');
    assert.equal(await bad({ toAccountId: rent }), 'bank.not_cash_account');
    assert.equal(await bad({ fee: 50 }), 'bank.fee_account');
    assert.equal(await bad({ fee: 50, feeAccountId: income }), 'bank.fee_account');
  });

  test('voiding a transfer reverses it; drafts can be edited and deleted', async () => {
    const { id } = await c.post('/api/bank/transfers', { date: '2026-01-07', fromAccountId: cash, toAccountId: bank, amount: 10_000 });
    await c.put(`/api/bank/transfers/${id}`, { date: '2026-01-07', fromAccountId: cash, toAccountId: bank, amount: 12_000 });
    await c.post(`/api/bank/transfers/${id}/post`);
    const before = await balance(bank);
    await c.post(`/api/bank/transfers/${id}/void`, {});
    assert.equal(await balance(bank), before - 12_000);
    assert.equal((await c.get(`/api/bank/transfers/${id}`)).status, 'void');
    const draft = (await c.post('/api/bank/transfers', { date: '2026-01-08', fromAccountId: cash, toAccountId: bank, amount: 500 })).id;
    await c.del(`/api/bank/transfers/${draft}`);
    assert.equal((await c.raw('GET', `/api/bank/transfers/${draft}`)).status, 404);
  });

  let statementId: number;
  test('reconcile: auto-match by amount and date, post the bank charges, then lock', async () => {
    // Books: a receipt of 50,000 on 01-20 and a rent payment of 30,000 on 01-25.
    await c.post('/api/payments', { direction: 'in', date: '2026-01-20', partyId: customer, partyRole: 'customer', accountId: bank, amount: 50_000, reference: 'DEP-7', post: true });
    await c.post('/api/journal', { date: '2026-01-25', memo: 'Rent', post: true, lines: [{ accountId: rent, debit: 30_000 }, { accountId: bank, credit: 30_000 }] });
    const next = await c.get(`/api/bank/statements/next?accountId=${bank}`);
    assert.equal(next.openingBalance, 0);
    statementId = (
      await c.post('/api/bank/statements', {
        accountId: bank,
        date: '2026-01-31',
        reference: 'Jan',
        closingBalance: 1_000_000 - 201_500 + 50_000 - 30_000 - 250,
        lines: [
          { date: '2026-01-01', description: 'Capital', amount: 1_000_000 },
          { date: '2026-01-05', description: 'Transfer to cash', amount: -201_500 },
          { date: '2026-01-22', description: 'Deposit', reference: 'DEP-7', amount: 50_000 },
          { date: '2026-01-26', description: 'Cheque 1001', amount: -30_000 },
          { date: '2026-01-31', description: 'Monthly fee', amount: -250 },
        ],
      })
    ).id;
    const matched = (await c.post(`/api/bank/statements/${statementId}/auto-match`)).matched;
    assert.equal(matched, 4, 'the voided transfer and its reversal cancel out and are left alone');
    let st = await c.get(`/api/bank/statements/${statementId}`);
    assert.equal(st.summary.unmatched, 1);
    assert.equal(st.summary.difference, 0);
    // Cannot close with an unmatched line.
    assert.equal((await c.raw('POST', `/api/bank/statements/${statementId}/reconcile`)).body.error.code, 'bank.unmatched');
    // Receivables need a receipt, not a direct entry.
    const fee = st.lines.find((l: any) => !l.journal_line_id);
    const ar = await acc(c, '1130');
    assert.equal((await c.raw('POST', `/api/bank/statement-lines/${fee.id}/entry`, { accountId: ar })).body.error.code, 'bank.use_payment');
    await c.post(`/api/bank/statement-lines/${fee.id}/entry`, { accountId: charges });
    st = await c.get(`/api/bank/statements/${statementId}`);
    assert.equal(st.summary.unmatched, 0);
    await c.post(`/api/bank/statements/${statementId}/reconcile`);
    assert.equal((await c.get(`/api/bank/statements/${statementId}`)).status, 'reconciled');
    // Ledger and statement agree.
    assert.equal(await balance(bank), st.closing_balance + 12_000 - 12_000);
  });

  test('a reconciled statement is locked, and its entries cannot be reversed', async () => {
    const st = await c.get(`/api/bank/statements/${statementId}`);
    const rentLine = st.lines.find((l: any) => l.amount === -30_000);
    assert.equal((await c.raw('POST', `/api/bank/statement-lines/${rentLine.id}/unmatch`)).body.error.code, 'bank.reconciled');
    const res = await c.raw('POST', `/api/journal/${rentLine.entry_id}/reverse`, {});
    assert.equal(res.body.error.code, 'bank.reconciled_entry');
    // The next statement must start where this one ended.
    const next = await c.get(`/api/bank/statements/next?accountId=${bank}`);
    assert.equal(next.openingBalance, st.closing_balance);
    const wrong = await c.raw('POST', '/api/bank/statements', { accountId: bank, date: '2026-02-28', openingBalance: 5, closingBalance: 5 });
    assert.equal(wrong.body.error.code, 'bank.opening_mismatch');
    // Reopen, then the entry may be reversed (and the tick must be removed by hand).
    await c.post(`/api/bank/statements/${statementId}/reopen`);
    assert.equal((await c.raw('POST', `/api/journal/${rentLine.entry_id}/reverse`, {})).status, 200);
  });

  test('manual matching checks account, amount and double use', async () => {
    const st = await c.get(`/api/bank/statements/${statementId}`);
    const rentLine = st.lines.find((l: any) => l.amount === -30_000);
    await c.post(`/api/bank/statement-lines/${rentLine.id}/unmatch`);
    // The rent entry was reversed: the pair cancels out and drops from the candidates…
    const book = (await c.get(`/api/bank/statements/${statementId}`)).book;
    assert.ok(!book.some((b: any) => b.entry_id === rentLine.entry_id));
    // …but a wrong amount is still refused when matched by hand.
    const rev = (await c.get(`/api/journal/${rentLine.entry_id}`)).reversed_by_id;
    const revLine = (await c.get(`/api/journal/${rev}`)).lines.find((l: any) => l.account_id === bank);
    assert.equal((await c.raw('POST', `/api/bank/statement-lines/${rentLine.id}/match`, { journalLineId: revLine.id })).body.error.code, 'bank.amount_mismatch');
    const taken = st.lines.find((l: any) => l.amount === 50_000).journal_line_id;
    assert.equal((await c.raw('POST', `/api/bank/statement-lines/${rentLine.id}/match`, { journalLineId: taken })).body.error.code, 'bank.line_taken');
    await c.post(`/api/bank/statement-lines/${rentLine.id}/match`, { journalLineId: st.lines.find((l: any) => l.amount === -30_000).journal_line_id });
    const health = await c.get('/api/system/health');
    const bankHealth = health.find((m: any) => m.module === 'bank');
    assert.ok(bankHealth.checks.every((x: any) => x.ok));
  });

  test('rights: statements and transfers are separate from receipts and payments', async () => {
    const role = (await c.post('/api/roles', { name: 'Bank clerk', permissions: ['treasury.statements.read', 'treasury.statements.write'] })).id;
    await c.post('/api/users', { username: 'bankclerk', displayName: 'Bank clerk', password: 'password123', roleIds: [role] });
    const cookie = await c.login('bankclerk', 'password123');
    assert.equal((await c.raw('GET', '/api/bank/accounts', undefined, cookie)).status, 200);
    assert.equal((await c.raw('GET', '/api/bank/transfers', undefined, cookie)).status, 403);
    assert.equal((await c.raw('POST', `/api/bank/statements/${statementId}/reconcile`, {}, cookie)).status, 403);
    // A transfers-only clerk still gets the account list for the transfer form, but no statements.
    const tr = (await c.post('/api/roles', { name: 'Transfers', permissions: ['treasury.transfers.read', 'treasury.transfers.write'] })).id;
    await c.post('/api/users', { username: 'trclerk', displayName: 'Transfers clerk', password: 'password123', roleIds: [tr] });
    const c2 = await c.login('trclerk', 'password123');
    assert.equal((await c.raw('GET', '/api/bank/accounts', undefined, c2)).status, 200);
    assert.equal((await c.raw('GET', '/api/bank/statements', undefined, c2)).status, 403);
    assert.equal((await c.raw('POST', '/api/bank/transfers', { date: '2026-02-01', fromAccountId: bank, toAccountId: cash, amount: 100, post: true }, c2)).status, 403);
  });
});
