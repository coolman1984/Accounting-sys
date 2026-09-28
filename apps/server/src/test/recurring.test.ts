import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';
import { dueDates, fillPlaceholders, occurrence } from '../modules/recurring/engine.js';

/**
 * Monthly rent (journal) from 31 January: 31 Jan, 28 Feb, 31 Mar, 30 Apr — memo "Rent {month}".
 * A quarterly maintenance invoice from 15 January, posted automatically: 15 Jan, 15 Apr, 15 Jul.
 */
describe('recurring documents and entries', () => {
  let c: TestClient;
  const K = 100;
  let bank: number, rent: number, ar: number, customer: number, rentT: number, invT: number;
  const balance = async (id: number) => {
    const t = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    const r = t.rows.find((x: any) => x.id === id);
    return r ? r.closing_debit - r.closing_credit : 0;
  };

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    [bank, rent, ar] = await Promise.all(['1120', '5220', '1130'].map((x) => acc(c, x)));
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Nile Towers' })).id;
  });
  after(() => c.close());

  test('engine: month ends clamp, weekly and quarterly steps, placeholders', () => {
    assert.deepEqual([0, 1, 2, 3].map((n) => occurrence('2026-01-31', 'monthly', 1, n)), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    assert.equal(occurrence('2026-01-15', 'quarterly', 1, 2), '2026-07-15');
    assert.equal(occurrence('2026-12-30', 'weekly', 2, 1), '2027-01-13');
    assert.equal(occurrence('2024-02-29', 'yearly', 1, 1), '2025-02-28');
    assert.deepEqual(dueDates({ first: '2026-01-10', frequency: 'monthly', interval: 1, done: 1, endDate: '2026-03-31', maxCount: null }, '2026-12-31'), ['2026-02-10', '2026-03-10']);
    assert.deepEqual(dueDates({ first: '2026-01-10', frequency: 'monthly', interval: 1, done: 0, endDate: null, maxCount: 2 }, '2026-12-31'), ['2026-01-10', '2026-02-10']);
    assert.equal(fillPlaceholders('Rent {month} ({year})', '2026-02-28'), 'Rent 2026-02 (2026)');
  });

  test('a template is checked by a trial run and nothing is left behind', async () => {
    const bad = await c.raw('POST', '/api/recurring', { name: 'Bad', kind: 'journal', firstDate: '2026-01-31', payload: { lines: [{ accountId: rent, debit: 100, credit: 0 }, { accountId: bank, debit: 0, credit: 50 }] } });
    assert.equal(bad.body.error.code, 'journal.unbalanced');
    const noParty = await c.raw('POST', '/api/recurring', { name: 'Bad', kind: 'journal', firstDate: '2026-01-31', payload: { lines: [{ accountId: ar, debit: 100, credit: 0 }, { accountId: bank, debit: 0, credit: 100 }] } });
    assert.equal(noParty.body.error.code, 'journal.party_required', 'the trial run catches what posting would refuse');
    assert.equal(c.app.kernel.db.get<{ n: number }>('SELECT COUNT(*) n FROM journal_entries')!.n, 0);
  });

  test('monthly rent catches up every month due, with the month in the memo', async () => {
    rentT = (
      await c.post('/api/recurring', {
        name: 'Office rent', kind: 'journal', frequency: 'monthly', firstDate: '2026-01-31', autoPost: true,
        payload: { memo: 'Rent {month}', lines: [{ accountId: rent, debit: 12_000 * K, credit: 0 }, { accountId: bank, debit: 0, credit: 12_000 * K }] },
      })
    ).id;
    const due = await c.get('/api/recurring/due?upTo=2026-04-30');
    assert.deepEqual(due.find((d: any) => d.id === rentT).dates, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    const g = await c.post('/api/recurring/generate', { upTo: '2026-04-30' });
    assert.equal(g.results.filter((r: any) => r.ok).length, 4);
    assert.equal(await balance(rent), 48_000 * K);
    const memos = c.app.kernel.db.all<{ memo: string; date: string }>("SELECT memo, date FROM journal_entries WHERE status = 'posted' ORDER BY date").map((e) => e.memo);
    assert.deepEqual(memos, ['Rent 2026-01', 'Rent 2026-02', 'Rent 2026-03', 'Rent 2026-04']);
    const again = await c.post('/api/recurring/generate', { upTo: '2026-04-30' });
    assert.equal(again.results.length, 0, 'nothing is made twice');
    const t = await c.get(`/api/recurring/${rentT}`);
    assert.equal(t.next_date, '2026-05-31');
    const lock = await c.raw('PUT', `/api/recurring/${rentT}`, { name: 'Office rent', kind: 'journal', frequency: 'quarterly', firstDate: '2026-01-31', payload: t.payload });
    assert.equal(lock.body.error.code, 'recurring.schedule_locked');
  });

  test('invoices: a failure stops that template without skipping a date, and it catches up later', async () => {
    invT = (
      await c.post('/api/recurring', {
        name: 'Maintenance contract', kind: 'sales_invoice', frequency: 'quarterly', firstDate: '2026-01-15', autoPost: true,
        payload: { partyId: customer, notes: 'Maintenance {month}', lines: [{ description: 'Quarterly maintenance', quantity: 1000, unitPrice: 9_000 * K }] },
      })
    ).id;
    const p = await c.get(`/api/parties/${customer}`);
    await c.put(`/api/parties/${customer}`, { kind: 'customer', name: p.name, code: p.code, isActive: false });
    const g = await c.post('/api/recurring/generate', { upTo: '2026-08-01', templateId: invT });
    assert.equal(g.results.length, 1);
    assert.equal(g.results[0].ok, false);
    assert.equal((await c.get(`/api/recurring/${invT}`)).next_date, '2026-01-15', 'the failed date is still due');
    await c.put(`/api/parties/${customer}`, { kind: 'customer', name: p.name, code: p.code, isActive: true });
    const ok = await c.post('/api/recurring/generate', { upTo: '2026-08-01', templateId: invT });
    assert.deepEqual(ok.results.map((r: any) => r.date), ['2026-01-15', '2026-04-15', '2026-07-15']);
    assert.equal(await balance(ar), 27_000 * K);
    const del = await c.raw('DELETE', `/api/recurring/${invT}`);
    assert.equal(del.body.error.code, 'recurring.has_runs');
  });

  test('a draft made from a template can be deleted; its history still opens', async () => {
    const t = (
      await c.post('/api/recurring', { name: 'Drafts', kind: 'sales_invoice', firstDate: '2026-02-01', payload: { partyId: customer, lines: [{ description: 'Fee', quantity: 1000, unitPrice: 100 * K }] } })
    ).id;
    const g = await c.post('/api/recurring/generate', { upTo: '2026-02-01', templateId: t });
    await c.del(`/api/documents/${g.results[0].documentId}`);
    const view = await c.get(`/api/recurring/${t}`);
    assert.equal(view.runs[0].document_number, null);
  });

  test('making documents needs the rights for those documents', async () => {
    await c.post('/api/users', { username: 'viewer1', displayName: 'Viewer', password: 'password123', role: 'viewer' });
    const cookie = await c.login('viewer1', 'password123');
    const r = await c.raw('POST', '/api/recurring/generate', { upTo: '2026-08-01' }, cookie);
    assert.equal(r.status, 403);
  });
});
