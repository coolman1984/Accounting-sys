import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

/**
 * Nile owes two invoices (10,000 and 5,000). It gives a cheque for the first, due 15 April: the
 * invoice is settled on receipt and the money sits in cheques receivable until the bank clears it.
 * A second cheque (5,000) bounces: the invoice reopens and Nile owes again.
 * Delta is paid 8,000 by a cheque drawn on our bank, due 1 May; a second one is cancelled.
 */
describe('cheques: received and issued, clearing, bouncing, forecast', () => {
  let c: TestClient;
  const K = 100;
  let bank: number, ar: number, ap: number, nile: number, delta: number, inv1: number, inv2: number, bill: number, bill2: number;
  let chq1: number, chq2: number, out1: number;
  const balance = async (id: number) => {
    const t = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(t.balanced, true);
    const r = t.rows.find((x: any) => x.id === id);
    return r ? r.closing_debit - r.closing_credit : 0;
  };
  const doc = (kind: string, partyId: number, amount: number) =>
    c.post('/api/documents', { kind, partyId, date: '2026-03-01', dueDate: '2026-03-31', post: true, lines: [{ description: 'Work', quantity: 1000, unitPrice: amount * K }] }).then((r) => r.id as number);
  const settled = async (id: number) => (await c.get(`/api/documents/${id}`)).amount_settled;

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    [bank, ar, ap] = await Promise.all(['1120', '1130', '2110'].map((x) => acc(c, x)));
    nile = (await c.post('/api/parties', { kind: 'customer', name: 'Nile' })).id;
    delta = (await c.post('/api/parties', { kind: 'supplier', name: 'Delta' })).id;
    inv1 = await doc('sales_invoice', nile, 10_000);
    inv2 = await doc('sales_invoice', nile, 5_000);
    bill = await doc('purchase_bill', delta, 8_000);
    bill2 = await doc('purchase_bill', delta, 2_000);
  });
  after(() => c.close());

  test('a received cheque settles the invoice and waits in cheques receivable', async () => {
    const over = await c.raw('POST', '/api/cheques', { direction: 'received', chequeNo: 'X1', partyId: nile, amount: 100, date: '2026-03-10', dueDate: '2026-04-15', allocations: [{ documentId: inv1, amount: 200 }] });
    assert.equal(over.body.error.code, 'payment.over_allocated');
    chq1 = (await c.post('/api/cheques', { direction: 'received', chequeNo: '104455', bankName: 'CIB', partyId: nile, amount: 10_000 * K, date: '2026-03-10', dueDate: '2026-04-15', allocations: [{ documentId: inv1, amount: 10_000 * K }] })).id;
    assert.equal(await settled(inv1), 10_000 * K);
    const holding = c.app.kernel.db.get<{ receivable_account_id: number }>('SELECT * FROM cheque_settings WHERE id = 1')!.receivable_account_id;
    assert.equal(await balance(holding), 10_000 * K);
    const acc = c.app.kernel.db.get<{ code: string; name_en: string }>('SELECT code, name_en FROM accounts WHERE id = ?', [holding])!;
    assert.deepEqual({ ...acc }, { code: '1155', name_en: 'Cheques Receivable' }, 'never the VAT input account (1150) of the standard chart');
    const health = await c.get('/api/system/health');
    const check = health.find((m: any) => m.module === 'cheques').checks.find((x: any) => x.id === 'holding');
    assert.equal(check.ok, true);
    assert.equal(await balance(ar), 5_000 * K, 'only the second invoice is still owed');
    const dup = await c.raw('POST', '/api/cheques', { direction: 'received', chequeNo: '104455', partyId: nile, amount: 1, date: '2026-03-10', dueDate: '2026-04-15' });
    assert.equal(dup.body.error.code, 'cheque.duplicate');
    const v = await c.raw('POST', `/api/documents/${inv1}/void`, {});
    assert.equal(v.body.error.code, 'document.has_settlements', 'an invoice paid by cheque cannot be voided');
  });

  test('deposit then clearing moves the money to the bank', async () => {
    await c.post(`/api/cheques/${chq1}/deposit`, { date: '2026-04-14', bankAccountId: bank });
    await c.post(`/api/cheques/${chq1}/clear`, { date: '2026-04-16' });
    const x = await c.get(`/api/cheques/${chq1}`);
    assert.equal(x.status, 'cleared');
    assert.equal(await balance(bank), 10_000 * K);
    const again = await c.raw('POST', `/api/cheques/${chq1}/cancel`, { date: '2026-04-20', outcome: 'bounced' });
    assert.equal(again.body.error.code, 'cheque.bad_status');
  });

  test('a bounced cheque reopens the invoice and the customer owes again', async () => {
    chq2 = (await c.post('/api/cheques', { direction: 'received', chequeNo: '200', partyId: nile, amount: 5_000 * K, date: '2026-03-12', dueDate: '2026-04-20', allocations: [{ documentId: inv2, amount: 5_000 * K }] })).id;
    assert.equal(await balance(ar), 0);
    await c.post(`/api/cheques/${chq2}/deposit`, { date: '2026-04-19', bankAccountId: bank });
    await c.post(`/api/cheques/${chq2}/cancel`, { date: '2026-04-22', outcome: 'bounced', reason: 'Insufficient funds' });
    assert.equal(await settled(inv2), 0);
    assert.equal(await balance(ar), 5_000 * K);
    const holding = c.app.kernel.db.get<{ receivable_account_id: number }>('SELECT * FROM cheque_settings WHERE id = 1')!.receivable_account_id;
    assert.equal(await balance(holding), 0);
  });

  test('issued cheques: settle the bill, appear in the forecast, clear from the bank', async () => {
    out1 = (await c.post('/api/cheques', { direction: 'issued', chequeNo: 'A-001', partyId: delta, amount: 8_000 * K, date: '2026-04-10', dueDate: '2026-05-01', bankAccountId: bank, allocations: [{ documentId: bill, amount: 8_000 * K }] })).id;
    const out2 = (await c.post('/api/cheques', { direction: 'issued', chequeNo: 'A-002', partyId: delta, amount: 2_000 * K, date: '2026-04-10', dueDate: '2026-06-01', bankAccountId: bank, allocations: [{ documentId: bill2, amount: 2_000 * K }] })).id;
    assert.equal(await balance(ap), 0);
    const p = await c.get('/api/cheques/portfolio?asOf=2026-04-25');
    assert.equal(p.issued.week, 8_000 * K);
    assert.equal(p.issued.quarter, 2_000 * K);
    const f = await c.get('/api/cashflow/forecast?asOf=2026-04-25&granularity=week');
    const flows = f.buckets.flatMap((b: any) => b.flows).filter((x: any) => x.source === 'cheques');
    assert.deepEqual(flows.map((x: any) => [x.date, x.amount]).sort(), [['2026-05-01', -8_000 * K], ['2026-06-01', -2_000 * K]]);
    await c.post(`/api/cheques/${out2}/cancel`, { date: '2026-04-26', outcome: 'cancelled' });
    assert.equal(await balance(ap), -2_000 * K, 'the bill is owed again');
    await c.post(`/api/cheques/${out1}/clear`, { date: '2026-05-02' });
    assert.equal(await balance(bank), 2_000 * K);
    await c.post(`/api/cheques/${out1}/unclear`);
    assert.equal(await balance(bank), 10_000 * K);
    assert.equal((await c.get(`/api/cheques/${out1}`)).status, 'issued');
  });
});
